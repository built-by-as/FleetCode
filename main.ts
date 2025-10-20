import {exec} from "child_process";
import {app, BrowserWindow, dialog, ipcMain} from "electron";
import Store from "electron-store";
import * as fs from "fs";
import * as pty from "node-pty";
import * as os from "os";
import * as path from "path";
import {simpleGit} from "simple-git";
import {promisify} from "util";
import {v4 as uuidv4} from "uuid";
import {PersistedSession, SessionConfig} from "./types";
import {isTerminalReady} from "./terminal-utils";

const execAsync = promisify(exec);

let mainWindow: BrowserWindow;
const activePtyProcesses = new Map<string, pty.IPty>();
const mcpPollerPtyProcesses = new Map<string, pty.IPty>();
let claudeCommandRunnerPty: pty.IPty | null = null;
const store = new Store();

// Helper functions for session management
function getPersistedSessions(): PersistedSession[] {
  return (store as any).get("sessions", []);
}

function getWorktreeBaseDir(): string {
  const settings = (store as any).get("terminalSettings");
  if (settings && settings.worktreeDir) {
    return settings.worktreeDir;
  }
  return path.join(os.homedir(), "worktrees");
}

function savePersistedSessions(sessions: PersistedSession[]) {
  (store as any).set("sessions", sessions);
}

function getNextSessionNumber(): number {
  const sessions = getPersistedSessions();
  if (sessions.length === 0) return 1;
  return Math.max(...sessions.map(s => s.number)) + 1;
}

// Extract MCP config for a project from ~/.claude.json
function extractProjectMcpConfig(projectDir: string): any {
  try {
    const claudeConfigPath = path.join(os.homedir(), ".claude.json");

    if (!fs.existsSync(claudeConfigPath)) {
      return {};
    }

    const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf8"));

    if (!claudeConfig.projects || !claudeConfig.projects[projectDir]) {
      return {};
    }

    return claudeConfig.projects[projectDir].mcpServers || {};
  } catch (error) {
    console.error("Error extracting MCP config:", error);
    return {};
  }
}

// Get a safe directory name from project path, with collision handling
function getProjectWorktreeDirName(projectDir: string): string {
  const baseName = path.basename(projectDir);
  const worktreesBaseDir = getWorktreeBaseDir();
  const candidatePath = path.join(worktreesBaseDir, baseName);

  // If directory doesn't exist or points to the same project, use base name
  if (!fs.existsSync(candidatePath)) {
    return baseName;
  }

  // Check if existing directory is for the same project by reading a marker file
  const markerFile = path.join(candidatePath, ".fleetcode-project");
  if (fs.existsSync(markerFile)) {
    const existingProjectPath = fs.readFileSync(markerFile, "utf-8").trim();
    if (existingProjectPath === projectDir) {
      return baseName;
    }
  }

  // Collision detected - append short hash
  const crypto = require("crypto");
  const hash = crypto.createHash("md5").update(projectDir).digest("hex").substring(0, 6);
  return `${baseName}-${hash}`;
}

// Write MCP config file for a project (shared across all sessions)
function writeMcpConfigFile(projectDir: string, mcpServers: any): string | null {
  try {
    const projectDirName = getProjectWorktreeDirName(projectDir);
    const worktreesDir = getWorktreeBaseDir();
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    const configFilePath = path.join(worktreesDir, projectDirName, "mcp-config.json");
    const configContent = JSON.stringify({ mcpServers }, null, 2);

    // Ensure project worktree directory exists
    const projectWorktreeDir = path.join(worktreesDir, projectDirName);
    if (!fs.existsSync(projectWorktreeDir)) {
      fs.mkdirSync(projectWorktreeDir, { recursive: true });
    }

    fs.writeFileSync(configFilePath, configContent, "utf8");

    return configFilePath;
  } catch (error) {
    console.error("Error writing MCP config file:", error);
    return null;
  }
}

// Spawn headless PTY for MCP polling
function spawnMcpPoller(sessionId: string, projectDir: string) {
  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  const ptyProcess = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: projectDir,
    env: process.env,
  });

  mcpPollerPtyProcesses.set(sessionId, ptyProcess);

  let outputBuffer = "";
  const serverMap = new Map<string, any>();

  ptyProcess.onData((data) => {

    // Accumulate output without displaying it
    outputBuffer += data;

    // Parse output whenever we have MCP server entries
    // Match lines like: "servername: url (type) - ✓ Connected" or "servername: command (stdio) - ✓ Connected"
    // Pattern handles SSE, stdio, and HTTP types (case-insensitive) with success (✓), warning (⚠), or failure (✗) status
    const mcpServerLineRegex = /^[\w-]+:.+\((?:SSE|sse|stdio|HTTP)\)\s+-\s+[✓⚠✗]/mi;

    if (mcpServerLineRegex.test(data) || data.includes("No MCP servers configured")) {
      try {
        const servers = parseMcpOutput(outputBuffer);

        // Clear and replace the server map with current results
        serverMap.clear();
        servers.forEach(server => {
          serverMap.set(server.name, server);
        });

        const allServers = Array.from(serverMap.values());

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("mcp-servers-updated", sessionId, allServers);
        }
      } catch (error) {
        console.error(`[MCP Poller ${sessionId}] Error parsing:`, error);
      }
    }

    // Clear buffer when we see the shell prompt (command finished)
    if ((data.includes("% ") || data.includes("$ ") || data.includes("➜ ")) &&
        outputBuffer.includes("claude mcp list")) {
      outputBuffer = "";
    }
  });

  // Start polling immediately and then every 60 seconds
  const pollMcp = () => {
    if (mcpPollerPtyProcesses.has(sessionId)) {
      // Notify renderer that polling is starting
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("mcp-polling-started", sessionId);
      }

      const command = `claude mcp list`;
      ptyProcess.write(command + "\r");
      setTimeout(pollMcp, 60000);
    }
  };

  // Wait briefly for shell to be ready before first poll
  setTimeout(() => {
    pollMcp();
  }, 500);
}

// Parse MCP server list output
function parseMcpOutput(output: string): any[] {
  const servers = [];

  if (output.includes("No MCP servers configured")) {
    return [];
  }

  const lines = output.trim().split("\n").filter(line => line.trim());

  for (const line of lines) {
    // Skip header lines, empty lines, and status messages
    if (line.includes("MCP servers") ||
        line.includes("---") ||
        line.includes("Checking") ||
        line.includes("health") ||
        line.includes("claude mcp list") ||
        !line.trim()) {
      continue;
    }

    // Only parse lines that match the MCP server format
    // Must have: "name: something (SSE|stdio|HTTP) - status"
    const serverMatch = line.match(/^([\w-]+):.+\((?:SSE|sse|stdio|HTTP)\)\s+-\s+[✓⚠✗]/i);
    if (serverMatch) {
      const serverName = serverMatch[1];
      const isConnected = line.includes("✓") || line.includes("Connected");

      servers.push({
        name: serverName,
        connected: isConnected
      });
    }
  }

  return servers;
}

// Helper function to spawn PTY and setup coding agent
function spawnSessionPty(
  sessionId: string,
  worktreePath: string,
  config: SessionConfig,
  sessionUuid: string,
  isNewSession: boolean,
  mcpConfigPath?: string,
  projectDir?: string
) {
  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  const ptyProcess = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: worktreePath,
    env: process.env,
  });

  activePtyProcesses.set(sessionId, ptyProcess);

  let terminalReady = false;
  let readyChecksCompleted = 0;
  let lastReadyCheckPos = 0;
  let setupCommandsIdx = 0;
  let dataBuffer = "";

  ptyProcess.onData((data) => {
    // Only send data if window still exists and is not destroyed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("session-output", sessionId, data);
    }

    // Detect when terminal is ready
    if (!terminalReady) {
      dataBuffer += data;

      if (isTerminalReady(dataBuffer, lastReadyCheckPos)) {
        readyChecksCompleted++;
        lastReadyCheckPos = dataBuffer.length;

        if (config.setupCommands && setupCommandsIdx < config.setupCommands.length) {
          const cmd = config.setupCommands[setupCommandsIdx];
          ptyProcess.write(cmd + "\r");
          setupCommandsIdx++;
        } else {
          terminalReady = true;

          // Auto-run the selected coding agent
          if (config.codingAgent === "claude") {
            const sessionFlag = isNewSession
              ? `--session-id ${sessionUuid}`
              : `--resume ${sessionUuid}`;
            const skipPermissionsFlag = config.skipPermissions ? "--dangerously-skip-permissions" : "";
            const mcpConfigFlag = mcpConfigPath ? `--mcp-config ${mcpConfigPath}` : "";
            const flags = [sessionFlag, skipPermissionsFlag, mcpConfigFlag].filter(f => f).join(" ");
            const claudeCmd = `claude ${flags}`;
            ptyProcess.write(claudeCmd + "\r");

            // Start MCP poller immediately (auth is handled by shell environment)
            if (!mcpPollerPtyProcesses.has(sessionId) && projectDir) {
              spawnMcpPoller(sessionId, projectDir);
            }
          } else if (config.codingAgent === "codex") {
            ptyProcess.write("codex\r");
          }
        }
      }
    }
  });

  return ptyProcess;
}

// Git worktree helper functions
// No longer needed since worktrees are in ~/worktrees, not in project directory

async function createWorktree(projectDir: string, parentBranch: string, sessionNumber: number, sessionUuid: string, customBranchName?: string): Promise<{ worktreePath: string; branchName: string }> {
  const git = simpleGit(projectDir);

  const projectDirName = getProjectWorktreeDirName(projectDir);
  const worktreesBaseDir = getWorktreeBaseDir();
  const projectWorktreeDir = path.join(worktreesBaseDir, projectDirName);
  const worktreeName = customBranchName || `session${sessionNumber}`;
  const worktreePath = path.join(projectWorktreeDir, worktreeName);

  // Use custom branch name if provided, otherwise generate default
  let branchName: string;
  if (customBranchName) {
    branchName = customBranchName;
  } else {
    // Include short UUID to ensure branch uniqueness across deletes/recreates
    const shortUuid = sessionUuid.split('-')[0];
    branchName = `fleetcode/${worktreeName}-${shortUuid}`;
  }

  // Create worktrees directory if it doesn't exist
  if (!fs.existsSync(projectWorktreeDir)) {
    fs.mkdirSync(projectWorktreeDir, { recursive: true });

    // Write marker file to track which project this directory belongs to
    const markerFile = path.join(projectWorktreeDir, ".fleetcode-project");
    fs.writeFileSync(markerFile, projectDir, "utf-8");
  }

  // Check if worktree already exists and remove it
  if (fs.existsSync(worktreePath)) {
    try {
      await git.raw(["worktree", "remove", worktreePath, "--force"]);
    } catch (error) {
      console.error("Error removing existing worktree:", error);
    }
  }

  // Delete the branch if it exists
  try {
    await git.raw(["branch", "-D", branchName]);
  } catch (error) {
    // Branch doesn't exist, that's fine
  }

  // Create new worktree with a new branch from parent branch
  // This creates a new branch named "fleetcode/session<N>" starting from the parent branch
  await git.raw(["worktree", "add", "-b", branchName, worktreePath, parentBranch]);

  return { worktreePath, branchName };
}

async function removeWorktree(projectDir: string, worktreePath: string) {
  const git = simpleGit(projectDir);
  try {
    await git.raw(["worktree", "remove", worktreePath, "--force"]);
  } catch (error) {
    console.error("Error removing worktree:", error);
  }
}

async function removeGitBranch(projectDir: string, branchName: string) {
  const git = simpleGit(projectDir);
  try {
    await git.raw(["branch", "-D", branchName]);
  } catch (error) {
    console.error("Error removing git branch:", error);
  }
}

// Open directory picker
ipcMain.handle("select-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// Get git branches from directory
ipcMain.handle("get-branches", async (_event, dirPath: string) => {
  try {
    const git = simpleGit(dirPath);
    const branchSummary = await git.branch();
    const branches = branchSummary.all;

    // Sort branches with main/master first
    return branches.sort((a, b) => {
      const aIsMain = a === 'main' || a === 'master';
      const bIsMain = b === 'main' || b === 'master';

      if (aIsMain && !bIsMain) return -1;
      if (!aIsMain && bIsMain) return 1;

      // If both or neither are main/master, keep original order
      return 0;
    });
  } catch (error) {
    console.error("Error getting branches:", error);
    return [];
  }
});

// Get last used settings
ipcMain.handle("get-last-settings", () => {
  return (store as any).get("lastSessionConfig", {
    projectDir: "",
    parentBranch: "",
    codingAgent: "claude",
    skipPermissions: true,
  });
});

// Save settings
ipcMain.on("save-settings", (_event, config: SessionConfig) => {
  (store as any).set("lastSessionConfig", config);
});

// Create new session
ipcMain.on("create-session", async (event, config: SessionConfig) => {
  try {
    const sessionNumber = getNextSessionNumber();
    const sessionId = `session-${Date.now()}`;

    // Use custom branch name as session name if provided, otherwise default
    const sessionName = config.branchName || `Session ${sessionNumber}`;

    // Generate UUID for this session (before creating worktree)
    const sessionUuid = uuidv4();

    // Create git worktree with custom or default branch name
    const { worktreePath, branchName } = await createWorktree(config.projectDir, config.parentBranch, sessionNumber, sessionUuid, config.branchName);

    // Extract and write MCP config
    const mcpServers = extractProjectMcpConfig(config.projectDir);
    const mcpConfigPath = writeMcpConfigFile(config.projectDir, mcpServers);

    // Create persisted session metadata
    const persistedSession: PersistedSession = {
      id: sessionId,
      number: sessionNumber,
      name: sessionName,
      config,
      worktreePath,
      createdAt: Date.now(),
      sessionUuid,
      mcpConfigPath: mcpConfigPath || undefined,
      gitBranch: branchName,
    };

    // Save to store
    const sessions = getPersistedSessions();
    sessions.push(persistedSession);
    savePersistedSessions(sessions);

    // Spawn PTY in worktree directory
    spawnSessionPty(sessionId, worktreePath, config, sessionUuid, true, mcpConfigPath || undefined, config.projectDir);

    event.reply("session-created", sessionId, persistedSession);
  } catch (error) {
    console.error("Error creating session:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    event.reply("session-error", errorMessage);
  }
});

// Handle session input
ipcMain.on("session-input", (_event, sessionId: string, data: string) => {
  const ptyProcess = activePtyProcesses.get(sessionId);

  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

// Handle session resize
ipcMain.on("session-resize", (_event, sessionId: string, cols: number, rows: number) => {
  const ptyProcess = activePtyProcesses.get(sessionId);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

// Reopen session (spawn new PTY for existing session)
ipcMain.on("reopen-session", (event, sessionId: string) => {
  // Check if PTY already active
  if (activePtyProcesses.has(sessionId)) {
    event.reply("session-reopened", sessionId);
    return;
  }

  // Find persisted session
  const sessions = getPersistedSessions();
  const session = sessions.find(s => s.id === sessionId);

  if (!session) {
    console.error("Session not found:", sessionId);
    return;
  }

  // Spawn new PTY in worktree directory
  spawnSessionPty(sessionId, session.worktreePath, session.config, session.sessionUuid, false, session.mcpConfigPath, session.config.projectDir);

  event.reply("session-reopened", sessionId);
});

// Close session (kill PTY but keep session)
ipcMain.on("close-session", (_event, sessionId: string) => {
  const ptyProcess = activePtyProcesses.get(sessionId);

  if (ptyProcess) {
    ptyProcess.kill();
    activePtyProcesses.delete(sessionId);
  }

  // Kill MCP poller if active
  const mcpPoller = mcpPollerPtyProcesses.get(sessionId);
  if (mcpPoller) {
    mcpPoller.kill();
    mcpPollerPtyProcesses.delete(sessionId);
  }
});

// Delete session (kill PTY, remove worktree, delete from store)
ipcMain.on("delete-session", async (_event, sessionId: string) => {
  // Kill PTY if active
  const ptyProcess = activePtyProcesses.get(sessionId);
  if (ptyProcess) {
    ptyProcess.kill();
    activePtyProcesses.delete(sessionId);
  }

  // Kill MCP poller if active
  const mcpPoller = mcpPollerPtyProcesses.get(sessionId);
  if (mcpPoller) {
    mcpPoller.kill();
    mcpPollerPtyProcesses.delete(sessionId);
  }

  // Find and remove from persisted sessions
  const sessions = getPersistedSessions();
  const sessionIndex = sessions.findIndex(s => s.id === sessionId);

  if (sessionIndex === -1) {
    console.error("Session not found:", sessionId);
    return;
  }

  const session = sessions[sessionIndex];

  // Remove git worktree
  await removeWorktree(session.config.projectDir, session.worktreePath);

  // Remove git branch if it exists
  if (session.gitBranch) {
    await removeGitBranch(session.config.projectDir, session.gitBranch);
  }

  // Remove from store
  sessions.splice(sessionIndex, 1);
  savePersistedSessions(sessions);

  mainWindow.webContents.send("session-deleted", sessionId);
});

// Get all persisted sessions
ipcMain.handle("get-all-sessions", () => {
  return getPersistedSessions();
});

// Rename session
ipcMain.on("rename-session", (_event, sessionId: string, newName: string) => {
  const sessions = getPersistedSessions();
  const session = sessions.find(s => s.id === sessionId);

  if (session) {
    session.name = newName;
    savePersistedSessions(sessions);
  }
});

// Terminal settings handlers
ipcMain.handle("get-terminal-settings", () => {
  return (store as any).get("terminalSettings");
});

ipcMain.handle("save-terminal-settings", (_event, settings: any) => {
  (store as any).set("terminalSettings", settings);
});

// MCP Server management functions
async function listMcpServers() {
  try {
    const { stdout } = await execAsync("claude mcp list");

    if (stdout.includes("No MCP servers configured")) {
      return [];
    }

    const lines = stdout.trim().split("\n").filter(line => line.trim());
    const servers = [];

    for (const line of lines) {
      // Skip header lines, empty lines, and status messages
      if (line.includes("MCP servers") ||
          line.includes("---") ||
          line.includes("Checking") ||
          line.includes("health") ||
          !line.trim()) {
        continue;
      }

      // Parse format: "name: url (type) - status" or just "name"
      // Extract server name (before the colon) and status
      const colonIndex = line.indexOf(":");
      const serverName = colonIndex > 0 ? line.substring(0, colonIndex).trim() : line.trim();

      // Check if server is connected (✓ Connected or similar)
      const isConnected = line.includes("✓") || line.includes("Connected");

      if (serverName) {
        servers.push({
          name: serverName,
          connected: isConnected
        });
      }
    }

    return servers;
  } catch (error) {
    console.error("Error listing MCP servers:", error);
    return [];
  }
}

// Spawn a dedicated PTY for running claude commands
function spawnClaudeCommandRunner() {
  if (claudeCommandRunnerPty) {
    return;
  }

  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  claudeCommandRunnerPty = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: os.homedir(),
    env: process.env,
  });
}

// Execute claude command in dedicated PTY
async function execClaudeCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!claudeCommandRunnerPty) {
      reject(new Error("Claude command runner PTY not initialized"));
      return;
    }

    const pty = claudeCommandRunnerPty;
    let outputBuffer = "";
    let timeoutId: NodeJS.Timeout;
    let disposed = false;

    const dataHandler = pty.onData((data: string) => {
      if (disposed) return;

      outputBuffer += data;

      // Check if command completed (prompt returned)
      if (isTerminalReady(data)) {
        disposed = true;
        clearTimeout(timeoutId);
        dataHandler.dispose();

        // Extract just the command output (remove the command echo and prompt lines)
        const lines = outputBuffer.split('\n');
        const output = lines.slice(1, -1).join('\n').trim();
        resolve(output);
      }
    });

    // Set timeout
    timeoutId = setTimeout(() => {
      if (!disposed) {
        disposed = true;
        dataHandler.dispose();
        reject(new Error("Command timeout"));
      }
    }, 10000);

    pty.write(command + "\r");
  });
}

async function addMcpServer(name: string, config: any) {
  // Use add-json to support full configuration including env vars, headers, etc.
  const jsonConfig = JSON.stringify(config).replace(/'/g, "'\\''"); // Escape single quotes for shell
  const command = `claude mcp add-json --scope user "${name}" '${jsonConfig}'`;
  await execClaudeCommand(command);
}

async function removeMcpServer(name: string) {
  const command = `claude mcp remove "${name}"`;
  await execClaudeCommand(command);
}

async function getMcpServerDetails(name: string) {
  try {
    const output = await execClaudeCommand(`claude mcp get "${name}"`);

    // Parse the output to extract details
    const details: any = { name };
    const lines = output.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes("Scope:")) {
        details.scope = trimmed.replace("Scope:", "").trim();
      } else if (trimmed.includes("Status:")) {
        details.status = trimmed.replace("Status:", "").trim();
      } else if (trimmed.includes("Type:")) {
        details.type = trimmed.replace("Type:", "").trim();
      } else if (trimmed.includes("URL:")) {
        details.url = trimmed.replace("URL:", "").trim();
      } else if (trimmed.includes("Command:")) {
        details.command = trimmed.replace("Command:", "").trim();
      } else if (trimmed.includes("Args:")) {
        details.args = trimmed.replace("Args:", "").trim();
      }
    }

    return details;
  } catch (error) {
    console.error("Error getting MCP server details:", error);
    throw error;
  }
}

ipcMain.handle("list-mcp-servers", async (_event, sessionId: string) => {
  try {
    // Trigger an immediate MCP list command in the session's poller
    const mcpPoller = mcpPollerPtyProcesses.get(sessionId);
    if (mcpPoller) {
      mcpPoller.write("claude mcp list\r");
    }
    // Return empty array - actual results will come via mcp-servers-updated event
    return [];
  } catch (error) {
    console.error("Error listing MCP servers:", error);
    return [];
  }
});

ipcMain.handle("add-mcp-server", async (_event, name: string, config: any) => {
  try {
    await addMcpServer(name, config);
  } catch (error) {
    console.error("Error adding MCP server:", error);
    throw error;
  }
});

ipcMain.handle("remove-mcp-server", async (_event, name: string) => {
  try {
    await removeMcpServer(name);
  } catch (error) {
    console.error("Error removing MCP server:", error);
    throw error;
  }
});

ipcMain.handle("get-mcp-server-details", async (_event, name: string) => {
  try {
    return await getMcpServerDetails(name);
  } catch (error) {
    console.error("Error getting MCP server details:", error);
    throw error;
  }
});

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile("index.html");

  // Load persisted sessions once window is ready
  mainWindow.webContents.on("did-finish-load", () => {
    const sessions = getPersistedSessions();
    mainWindow.webContents.send("load-persisted-sessions", sessions);
  });

  // Clean up PTY processes when window is closed
  mainWindow.on("closed", () => {
    // Kill all active PTY processes
    activePtyProcesses.forEach((ptyProcess, sessionId) => {
      try {
        ptyProcess.kill();
      } catch (error) {
        console.error(`Error killing PTY for session ${sessionId}:`, error);
      }
    });
    activePtyProcesses.clear();

    // Kill all MCP poller processes
    mcpPollerPtyProcesses.forEach((ptyProcess, sessionId) => {
      try {
        ptyProcess.kill();
      } catch (error) {
        console.error(`Error killing MCP poller for session ${sessionId}:`, error);
      }
    });
    mcpPollerPtyProcesses.clear();
  });
};

app.whenReady().then(() => {
  createWindow();

  // Spawn claude command runner PTY early so it's ready when needed (fire-and-forget)
  spawnClaudeCommandRunner();

  // Handles launch from dock on macos
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
