import { app, BrowserWindow, ipcMain } from "electron";
import * as pty from "node-pty";
import * as os from "os";

let mainWindow: BrowserWindow;
const terminals = new Map<string, pty.IPty>();

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

  // Create new terminal
  ipcMain.on("create-terminal", (event) => {
    const terminalId = `terminal-${Date.now()}`;
    const shell = os.platform() === "darwin" ? "zsh" : "bash";

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-color",
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      env: process.env,
    });

    terminals.set(terminalId, ptyProcess);

    ptyProcess.onData((data) => {
      mainWindow.webContents.send("terminal-output", terminalId, data);
    });

    event.reply("terminal-created", terminalId);
  });

  // Handle terminal input
  ipcMain.on("terminal-input", (_event, terminalId: string, data: string) => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      terminal.write(data);
    }
  });

  // Handle terminal resize
  ipcMain.on("terminal-resize", (_event, terminalId: string, cols: number, rows: number) => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      terminal.resize(cols, rows);
    }
  });

  // Handle terminal close
  ipcMain.on("close-terminal", (_event, terminalId: string) => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      terminal.kill();
      terminals.delete(terminalId);
    }
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
