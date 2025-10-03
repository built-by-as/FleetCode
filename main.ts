import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as pty from "node-pty";
import * as os from "os";
import { simpleGit } from "simple-git";

interface SessionConfig {
  projectDir: string;
  parentBranch: string;
  codingAgent: string;
}

let mainWindow: BrowserWindow;
const sessions = new Map<string, pty.IPty>();

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

// Create new session
ipcMain.on("create-session", (event, config: SessionConfig) => {
  const sessionId = `session-${Date.now()}`;
  const shell = os.platform() === "darwin" ? "zsh" : "bash";

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: config.projectDir || process.env.HOME,
    env: process.env,
  });

  sessions.set(sessionId, ptyProcess);

  let terminalReady = false;
  let dataBuffer = "";

  ptyProcess.onData((data) => {
    mainWindow.webContents.send("session-output", sessionId, data);

    // Detect when terminal is ready
    if (!terminalReady) {
      dataBuffer += data;

      // Method 1: Look for bracketed paste mode enable sequence
      // This is sent by modern shells (zsh, bash) when ready for input
      if (dataBuffer.includes("\x1b[?2004h")) {
        terminalReady = true;

        // Auto-run the selected coding agent
        if (config.codingAgent === "claude") {
          ptyProcess.write("claude\r");
        } else if (config.codingAgent === "codex") {
          ptyProcess.write("codex\r");
        }
      }

      // Method 2: Fallback - look for common prompt indicators
      // In case bracketed paste mode is disabled
      else if (dataBuffer.includes("$ ") || dataBuffer.includes("% ") ||
          dataBuffer.includes("> ") || dataBuffer.includes("➜ ") ||
          dataBuffer.includes("➜  ") ||
          dataBuffer.includes("✗ ") || dataBuffer.includes("✓ ") ||
          dataBuffer.endsWith("$") || dataBuffer.endsWith("%") ||
          dataBuffer.endsWith(">") || dataBuffer.endsWith("➜") ||
          dataBuffer.endsWith("✗") || dataBuffer.endsWith("✓")) {
        terminalReady = true;

        // Auto-run the selected coding agent
        if (config.codingAgent === "claude") {
          ptyProcess.write("claude\r");
        } else if (config.codingAgent === "codex") {
          ptyProcess.write("codex\r");
        }
      }
    }
  });

  event.reply("session-created", sessionId, config);
});

// Handle session input
ipcMain.on("session-input", (_event, sessionId: string, data: string) => {
  const session = sessions.get(sessionId);
  if (session) {
    session.write(data);
  }
});

// Handle session resize
ipcMain.on("session-resize", (_event, sessionId: string, cols: number, rows: number) => {
  const session = sessions.get(sessionId);
  if (session) {
    session.resize(cols, rows);
  }
});

// Handle session close
ipcMain.on("close-session", (_event, sessionId: string) => {
  const session = sessions.get(sessionId);
  if (session) {
    session.kill();
    sessions.delete(sessionId);
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
