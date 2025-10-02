import { app, BrowserWindow, ipcMain } from "electron";
import * as pty from "node-pty";
import * as os from "os";

let ptyProcess: pty.IPty;

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile("index.html");

  // Create a new PTY process for the terminal
  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env,
  });

  // Send terminal output to the renderer
  ptyProcess.onData((data) => {
    win.webContents.send("terminal-output", data);
  });

  // Receive input from the renderer
  ipcMain.on("terminal-input", (_event, data: string) => {
    ptyProcess.write(data);
  });

  // Handle terminal resize
  ipcMain.on("terminal-resize", (_event, cols: number, rows: number) => {
    ptyProcess.resize(cols, rows);
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
