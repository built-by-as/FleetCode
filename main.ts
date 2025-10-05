import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as pty from "node-pty";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { simpleGit } from "simple-git";
import Store from "electron-store";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";

const execAsync = promisify(exec);

interface SessionConfig {
  projectDir: string;
  parentBranch: string;
  codingAgent: string;
  skipPermissions: boolean;
  setupCommands?: string[];
}

interface PersistedSession {
  id: string;
  number: number;
  name: string;
  config: SessionConfig;
  worktreePath: string;
  createdAt: number;
  sessionUuid: string;
}

let mainWindow: BrowserWindow;
const activePtyProcesses = new Map<string, pty.IPty>();
const mcpPollerPtyProcesses = new Map<string, pty.IPty>();
const store = new Store();

// Helper functions for session management
function getPersistedSessions(): PersistedSession[] {
  return (store as any).get("sessions", []);
}

function savePersistedSessions(sessions: PersistedSession[]) {
  (store as any).set("sessions", sessions);
}

function getNextSessionNumber(): number {
  const sessions = getPersistedSessions();
  if (sessions.length === 0) return 1;
  return Math.max(...sessions.map(s => s.number)) + 1;
}

// Spawn headless PTY for MCP polling
function spawnMcpPoller(sessionId: string, worktreePath: string) {
  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  const ptyProcess = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: worktreePath,
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
    // Pattern handles both SSE (with URLs) and stdio (with commands/paths)
    const mcpServerLineRegex = /^[\w-]+:.+\((?:SSE|stdio)\)\s+-\s+[✓⚠]/m;

    if (mcpServerLineRegex.test(data) || data.includes("No MCP servers configured")) {
      try {
        const servers = parseMcpOutput(outputBuffer);

        // Merge servers into the map (upsert by name)
        servers.forEach(server => {
          serverMap.set(server.name, server);
        });

        const allServers = Array.from(serverMap.values());

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("mcp-servers-updated", sessionId, allServers);
        }
      } catch (error) {
        console.error("Error parsing MCP output:", error);
      }
    }

    // Clear buffer when we see the shell prompt (command finished)
    if ((data.includes("% ") || data.includes("$ ") || data.includes("➜ ")) &&
        outputBuffer.includes("claude mcp list")) {
      outputBuffer = "";
    }
  });

  // Wait for shell to be ready, then start polling loop
  setTimeout(() => {
    // Run `claude mcp list` every 60 seconds
    const pollMcp = () => {
      if (mcpPollerPtyProcesses.has(sessionId)) {
        ptyProcess.write("claude mcp list\r");
        setTimeout(pollMcp, 60000);
      }
    };
    pollMcp();
  }, 2000); // Wait 2s for shell to initialize
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
    // Must have: "name: something (SSE|stdio) - status"
    const serverMatch = line.match(/^([\w-]+):.+\((?:SSE|stdio)\)\s+-\s+[✓⚠]/);
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
  isNewSession: boolean
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
  let claudeReady = false;
  let dataBuffer = "";

  ptyProcess.onData((data) => {
    // Only send data if window still exists and is not destroyed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("session-output", sessionId, data);
    }

    // Detect when terminal is ready
    if (!terminalReady) {
      dataBuffer += data;

      // Method 1: Look for bracketed paste mode enable sequence
      // Method 2: Fallback - look for common prompt indicators
      const isReady = dataBuffer.includes("\x1b[?2004h") ||
        dataBuffer.includes("$ ") || dataBuffer.includes("% ") ||
        dataBuffer.includes("> ") || dataBuffer.includes("➜ ") ||
        dataBuffer.includes("➜  ") || dataBuffer.includes("✗ ") ||
        dataBuffer.includes("✓ ") || dataBuffer.endsWith("$") ||
        dataBuffer.endsWith("%") || dataBuffer.endsWith(">") ||
        dataBuffer.endsWith("➜") || dataBuffer.endsWith("✗") ||
        dataBuffer.endsWith("✓");

      if (isReady) {
        terminalReady = true;

        // Run setup commands if provided
        if (config.setupCommands && config.setupCommands.length > 0) {
          config.setupCommands.forEach(cmd => {
            ptyProcess.write(cmd + "\r");
          });
        }

        // Auto-run the selected coding agent
        if (config.codingAgent === "claude") {
          const sessionFlag = isNewSession
            ? `--session-id ${sessionUuid}`
            : `--resume ${sessionUuid}`;
          const skipPermissionsFlag = config.skipPermissions ? "--dangerously-skip-permissions" : "";
          const flags = [sessionFlag, skipPermissionsFlag].filter(f => f).join(" ");
          const claudeCmd = `claude ${flags}\r`;
          ptyProcess.write(claudeCmd);
        } else if (config.codingAgent === "codex") {
          ptyProcess.write("codex\r");
        }
      }
    }

    // Detect when Claude is ready (shows "> " prompt)
    if (terminalReady && !claudeReady && config.codingAgent === "claude") {
      if (data.includes("> ")) {
        claudeReady = true;
        // Spawn MCP poller now that Claude is authenticated and ready
        // Check if poller doesn't already exist to prevent duplicates
        if (!mcpPollerPtyProcesses.has(sessionId)) {
          spawnMcpPoller(sessionId, worktreePath);
        }
      }
    }
  });

  return ptyProcess;
}

// Git worktree helper functions
async function ensureFleetcodeExcluded(projectDir: string) {
  // Check if we've already initialized this project (persisted across app restarts)
  const initializedProjects: string[] = (store as any).get("excludeInitializedProjects", []);
  if (initializedProjects.includes(projectDir)) {
    return;
  }

  const excludeFilePath = path.join(projectDir, ".git", "info", "exclude");
  const excludeEntry = ".fleetcode/";

  try {
    // Ensure .git/info directory exists
    const infoDir = path.dirname(excludeFilePath);
    if (!fs.existsSync(infoDir)) {
      fs.mkdirSync(infoDir, { recursive: true });
    }

    // Read existing exclude file or create empty string
    let excludeContent = "";
    if (fs.existsSync(excludeFilePath)) {
      excludeContent = fs.readFileSync(excludeFilePath, "utf-8");
    }

    // Check if .fleetcode/ is already excluded
    if (!excludeContent.includes(excludeEntry)) {
      // Add .fleetcode/ to exclude file
      const newContent = excludeContent.trim() + (excludeContent.trim() ? "\n" : "") + excludeEntry + "\n";
      fs.writeFileSync(excludeFilePath, newContent, "utf-8");
    }

    // Mark this project as initialized and persist
    initializedProjects.push(projectDir);
    (store as any).set("excludeInitializedProjects", initializedProjects);
  } catch (error) {
    console.error("Error ensuring .fleetcode excluded:", error);
  }
}

async function createWorktree(projectDir: string, parentBranch: string, sessionNumber: number, sessionUuid: string): Promise<string> {
  const git = simpleGit(projectDir);
  const fleetcodeDir = path.join(projectDir, ".fleetcode");
  const worktreeName = `session${sessionNumber}`;
  const worktreePath = path.join(fleetcodeDir, worktreeName);
  // Include short UUID to ensure branch uniqueness across deletes/recreates
  const shortUuid = sessionUuid.split('-')[0];
  const branchName = `fleetcode/session${sessionNumber}-${shortUuid}`;

  // Create .fleetcode directory if it doesn't exist
  if (!fs.existsSync(fleetcodeDir)) {
    fs.mkdirSync(fleetcodeDir, { recursive: true });
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

  return worktreePath;
}

async function removeWorktree(projectDir: string, worktreePath: string) {
  const git = simpleGit(projectDir);
  try {
    await git.raw(["worktree", "remove", worktreePath, "--force"]);
  } catch (error) {
    console.error("Error removing worktree:", error);
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
    return branchSummary.all;
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
    const sessionName = `Session ${sessionNumber}`;

    // Generate UUID for this session (before creating worktree)
    const sessionUuid = uuidv4();

    // Ensure .fleetcode is excluded (async, don't wait)
    ensureFleetcodeExcluded(config.projectDir);

    // Create git worktree with unique branch name
    const worktreePath = await createWorktree(config.projectDir, config.parentBranch, sessionNumber, sessionUuid);

    // Create persisted session metadata
    const persistedSession: PersistedSession = {
      id: sessionId,
      number: sessionNumber,
      name: sessionName,
      config,
      worktreePath,
      createdAt: Date.now(),
      sessionUuid,
    };

    // Save to store
    const sessions = getPersistedSessions();
    sessions.push(persistedSession);
    savePersistedSessions(sessions);

    // Spawn PTY in worktree directory
    spawnSessionPty(sessionId, worktreePath, config, sessionUuid, true);

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
  spawnSessionPty(sessionId, session.worktreePath, session.config, session.sessionUuid, false);

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

async function addMcpServer(name: string, config: any) {
  // Use add-json to support full configuration including env vars, headers, etc.
  const jsonConfig = JSON.stringify(config);
  await execAsync(`claude mcp add-json --scope user "${name}" '${jsonConfig}'`);
}

async function removeMcpServer(name: string) {
  await execAsync(`claude mcp remove "${name}"`);
}

async function getMcpServerDetails(name: string) {
  try {
    const { stdout } = await execAsync(`claude mcp get "${name}"`);

    // Parse the output to extract details
    const details: any = { name };
    const lines = stdout.split("\n");

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
