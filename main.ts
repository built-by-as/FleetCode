import { app, BrowserWindow, ipcMain } from "electron";
import * as pty from "node-pty";
import * as os from "os";

let mainWindow: BrowserWindow;
const sessions = new Map<string, pty.IPty>();

// Create new session
ipcMain.on("create-session", (event) => {
  const sessionId = `session-${Date.now()}`;
  const shell = os.platform() === "darwin" ? "zsh" : "bash";

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env,
  });

  sessions.set(sessionId, ptyProcess);

  ptyProcess.onData((data) => {
    mainWindow.webContents.send("session-output", sessionId, data);
  });

  event.reply("session-created", sessionId);
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
