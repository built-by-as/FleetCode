const { app, BrowserWindow, ipcMain } = require("electron/main");
const pty = require("node-pty");
const os = require("os");

let ptyProcess;

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
  ipcMain.on("terminal-input", (event, data) => {
    ptyProcess.write(data);
  });

  // Handle terminal resize
  ipcMain.on("terminal-resize", (event, cols, rows) => {
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
