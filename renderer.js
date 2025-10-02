const { ipcRenderer } = require("electron");
const { Terminal } = require("xterm");
const { FitAddon } = require("xterm-addon-fit");

// Create terminal instance
const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: {
    background: "#000000",
    foreground: "#ffffff",
  },
});

// Create fit addon to make terminal fill the window
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// Open terminal in the DOM
term.open(document.getElementById("terminal"));
fitAddon.fit();

// Handle terminal input
term.onData((data) => {
  ipcRenderer.send("terminal-input", data);
});

// Handle terminal output from main process
ipcRenderer.on("terminal-output", (event, data) => {
  term.write(data);
});

// Handle window resize
window.addEventListener("resize", () => {
  fitAddon.fit();
  ipcRenderer.send("terminal-resize", term.cols, term.rows);
});

// Initial resize
setTimeout(() => {
  fitAddon.fit();
  ipcRenderer.send("terminal-resize", term.cols, term.rows);
}, 100);
