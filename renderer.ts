import { ipcRenderer } from "electron";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

interface TerminalSession {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  name: string;
}

const sessions = new Map<string, TerminalSession>();
let activeTerminalId: string | null = null;

function createTerminalSession(terminalId: string, name: string) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: "#000000",
      foreground: "#ffffff",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const terminalElement = document.createElement("div");
  terminalElement.className = "absolute inset-0 hidden";
  terminalElement.id = `term-${terminalId}`;

  const container = document.getElementById("terminal-container");
  if (container) {
    container.appendChild(terminalElement);
  }

  term.open(terminalElement);
  fitAddon.fit();

  term.onData((data) => {
    ipcRenderer.send("terminal-input", terminalId, data);
  });

  const session: TerminalSession = {
    id: terminalId,
    terminal: term,
    fitAddon,
    element: terminalElement,
    name,
  };

  sessions.set(terminalId, session);

  // Add to sidebar
  addToSidebar(terminalId, name);

  // Add tab
  addTab(terminalId, name);

  // Switch to this terminal
  switchToTerminal(terminalId);

  // Handle resize
  const resizeHandler = () => {
    if (activeTerminalId === terminalId) {
      fitAddon.fit();
      ipcRenderer.send("terminal-resize", terminalId, term.cols, term.rows);
    }
  };
  window.addEventListener("resize", resizeHandler);

  return session;
}

function addToSidebar(terminalId: string, name: string) {
  const list = document.getElementById("terminal-list");
  if (!list) return;

  const item = document.createElement("div");
  item.id = `sidebar-${terminalId}`;
  item.className = "px-3 py-2 rounded cursor-pointer hover:bg-gray-700 text-gray-300 text-sm flex items-center justify-between group";
  item.innerHTML = `
    <span class="truncate">${name}</span>
    <button class="close-btn opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-500 ml-2" data-id="${terminalId}">×</button>
  `;

  item.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).classList.contains("close-btn")) {
      switchToTerminal(terminalId);
    }
  });

  const closeBtn = item.querySelector(".close-btn");
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTerminal(terminalId);
  });

  list.appendChild(item);
}

function addTab(terminalId: string, name: string) {
  const tabsContainer = document.getElementById("tabs");
  if (!tabsContainer) return;

  const tab = document.createElement("div");
  tab.id = `tab-${terminalId}`;
  tab.className = "px-4 py-2 border-r border-gray-700 cursor-pointer hover:bg-gray-800 flex items-center space-x-2 min-w-max";
  tab.innerHTML = `
    <span class="text-sm text-gray-300">${name}</span>
    <button class="close-tab-btn text-gray-500 hover:text-red-500" data-id="${terminalId}">×</button>
  `;

  tab.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).classList.contains("close-tab-btn")) {
      switchToTerminal(terminalId);
    }
  });

  const closeBtn = tab.querySelector(".close-tab-btn");
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTerminal(terminalId);
  });

  tabsContainer.appendChild(tab);
}

function switchToTerminal(terminalId: string) {
  // Hide all terminals
  sessions.forEach((session, id) => {
    session.element.classList.add("hidden");
    document.getElementById(`tab-${id}`)?.classList.remove("bg-gray-800", "border-b-2", "border-blue-500");
    document.getElementById(`sidebar-${id}`)?.classList.remove("bg-gray-700");
  });

  // Show active terminal
  const session = sessions.get(terminalId);
  if (session) {
    session.element.classList.remove("hidden");
    document.getElementById(`tab-${terminalId}`)?.classList.add("bg-gray-800", "border-b-2", "border-blue-500");
    document.getElementById(`sidebar-${terminalId}`)?.classList.add("bg-gray-700");
    activeTerminalId = terminalId;

    // Focus and resize
    session.terminal.focus();
    setTimeout(() => {
      session.fitAddon.fit();
      ipcRenderer.send("terminal-resize", terminalId, session.terminal.cols, session.terminal.rows);
    }, 0);
  }
}

function closeTerminal(terminalId: string) {
  const session = sessions.get(terminalId);
  if (!session) return;

  // Remove from UI
  session.element.remove();
  document.getElementById(`tab-${terminalId}`)?.remove();
  document.getElementById(`sidebar-${terminalId}`)?.remove();

  // Dispose terminal
  session.terminal.dispose();
  sessions.delete(terminalId);

  // Close in main process
  ipcRenderer.send("close-terminal", terminalId);

  // Switch to another terminal
  if (activeTerminalId === terminalId) {
    const remainingSessions = Array.from(sessions.keys());
    if (remainingSessions.length > 0) {
      switchToTerminal(remainingSessions[0]);
    } else {
      activeTerminalId = null;
    }
  }
}

// Handle terminal output
ipcRenderer.on("terminal-output", (_event, terminalId: string, data: string) => {
  const session = sessions.get(terminalId);
  if (session) {
    session.terminal.write(data);
  }
});

// Handle terminal created
ipcRenderer.on("terminal-created", (_event, terminalId: string) => {
  const name = `Terminal ${sessions.size + 1}`;
  createTerminalSession(terminalId, name);
});

// New terminal button
document.getElementById("new-terminal")?.addEventListener("click", () => {
  ipcRenderer.send("create-terminal");
});
