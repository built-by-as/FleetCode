import { ipcRenderer } from "electron";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

interface SessionConfig {
  projectDir: string;
  parentBranch: string;
  codingAgent: string;
}

interface Session {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  name: string;
  config: SessionConfig;
}

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;

function createSession(sessionId: string, name: string, config: SessionConfig) {
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

  const sessionElement = document.createElement("div");
  sessionElement.className = "session-wrapper";
  sessionElement.id = `session-${sessionId}`;

  const container = document.getElementById("session-container");
  if (container) {
    container.appendChild(sessionElement);
  }

  term.open(sessionElement);
  fitAddon.fit();

  term.onData((data) => {
    ipcRenderer.send("session-input", sessionId, data);
  });

  const session: Session = {
    id: sessionId,
    terminal: term,
    fitAddon,
    element: sessionElement,
    name,
    config,
  };

  sessions.set(sessionId, session);

  // Add to sidebar
  addToSidebar(sessionId, name);

  // Add tab
  addTab(sessionId, name);

  // Switch to this session
  switchToSession(sessionId);

  // Handle resize
  const resizeHandler = () => {
    if (activeSessionId === sessionId) {
      fitAddon.fit();
      ipcRenderer.send("session-resize", sessionId, term.cols, term.rows);
    }
  };
  window.addEventListener("resize", resizeHandler);

  return session;
}

function addToSidebar(sessionId: string, name: string) {
  const list = document.getElementById("session-list");
  if (!list) return;

  const item = document.createElement("div");
  item.id = `sidebar-${sessionId}`;
  item.className = "session-list-item";
  item.innerHTML = `
    <span class="truncate">${name}</span>
    <button class="session-close-btn" data-id="${sessionId}">×</button>
  `;

  item.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).classList.contains("session-close-btn")) {
      switchToSession(sessionId);
    }
  });

  const closeBtn = item.querySelector(".session-close-btn");
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSession(sessionId);
  });

  list.appendChild(item);
}

function addTab(sessionId: string, name: string) {
  const tabsContainer = document.getElementById("tabs");
  if (!tabsContainer) return;

  const tab = document.createElement("div");
  tab.id = `tab-${sessionId}`;
  tab.className = "tab";
  tab.innerHTML = `
    <span class="tab-name">${name}</span>
    <button class="tab-close-btn" data-id="${sessionId}">×</button>
  `;

  tab.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).classList.contains("tab-close-btn")) {
      switchToSession(sessionId);
    }
  });

  const closeBtn = tab.querySelector(".tab-close-btn");
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSession(sessionId);
  });

  tabsContainer.appendChild(tab);
}

function switchToSession(sessionId: string) {
  // Hide all sessions
  sessions.forEach((session, id) => {
    session.element.classList.remove("active");
    document.getElementById(`tab-${id}`)?.classList.remove("active");
    document.getElementById(`sidebar-${id}`)?.classList.remove("active");
  });

  // Show active session
  const session = sessions.get(sessionId);
  if (session) {
    session.element.classList.add("active");
    document.getElementById(`tab-${sessionId}`)?.classList.add("active");
    document.getElementById(`sidebar-${sessionId}`)?.classList.add("active");
    activeSessionId = sessionId;

    // Focus and resize
    session.terminal.focus();
    setTimeout(() => {
      session.fitAddon.fit();
      ipcRenderer.send("session-resize", sessionId, session.terminal.cols, session.terminal.rows);
    }, 0);
  }
}

function closeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Remove from UI
  session.element.remove();
  document.getElementById(`tab-${sessionId}`)?.remove();
  document.getElementById(`sidebar-${sessionId}`)?.remove();

  // Dispose terminal
  session.terminal.dispose();
  sessions.delete(sessionId);

  // Close in main process
  ipcRenderer.send("close-session", sessionId);

  // Switch to another session
  if (activeSessionId === sessionId) {
    const remainingSessions = Array.from(sessions.keys());
    if (remainingSessions.length > 0) {
      switchToSession(remainingSessions[0]);
    } else {
      activeSessionId = null;
    }
  }
}

// Handle session output
ipcRenderer.on("session-output", (_event, sessionId: string, data: string) => {
  const session = sessions.get(sessionId);
  if (session) {
    session.terminal.write(data);
  }
});

// Handle session created
ipcRenderer.on("session-created", (_event, sessionId: string, config: SessionConfig) => {
  const name = `Session ${sessions.size + 1}`;
  createSession(sessionId, name, config);
});

// Modal handling
const modal = document.getElementById("config-modal");
const projectDirInput = document.getElementById("project-dir") as HTMLInputElement;
const parentBranchSelect = document.getElementById("parent-branch") as HTMLSelectElement;
const codingAgentSelect = document.getElementById("coding-agent") as HTMLSelectElement;
const browseDirBtn = document.getElementById("browse-dir");
const cancelBtn = document.getElementById("cancel-session");
const createBtn = document.getElementById("create-session");

let selectedDirectory = "";

// New session button - opens modal
document.getElementById("new-session")?.addEventListener("click", async () => {
  modal?.classList.remove("hidden");

  // Load last used settings
  const lastSettings = await ipcRenderer.invoke("get-last-settings");

  if (lastSettings.projectDir) {
    selectedDirectory = lastSettings.projectDir;
    projectDirInput.value = lastSettings.projectDir;

    // Load git branches for the last directory
    const branches = await ipcRenderer.invoke("get-branches", lastSettings.projectDir);
    parentBranchSelect.innerHTML = "";

    if (branches.length === 0) {
      parentBranchSelect.innerHTML = '<option value="">No git repository found</option>';
    } else {
      branches.forEach((branch: string) => {
        const option = document.createElement("option");
        option.value = branch;
        option.textContent = branch;
        if (branch === lastSettings.parentBranch) {
          option.selected = true;
        }
        parentBranchSelect.appendChild(option);
      });
    }
  }

  // Set last used coding agent
  if (lastSettings.codingAgent) {
    codingAgentSelect.value = lastSettings.codingAgent;
  }
});

// Browse directory
browseDirBtn?.addEventListener("click", async () => {
  const dir = await ipcRenderer.invoke("select-directory");
  if (dir) {
    selectedDirectory = dir;
    projectDirInput.value = dir;

    // Load git branches
    const branches = await ipcRenderer.invoke("get-branches", dir);
    parentBranchSelect.innerHTML = "";

    if (branches.length === 0) {
      parentBranchSelect.innerHTML = '<option value="">No git repository found</option>';
    } else {
      branches.forEach((branch: string) => {
        const option = document.createElement("option");
        option.value = branch;
        option.textContent = branch;
        parentBranchSelect.appendChild(option);
      });
    }
  }
});

// Cancel button
cancelBtn?.addEventListener("click", () => {
  modal?.classList.add("hidden");
  projectDirInput.value = "";
  selectedDirectory = "";
  parentBranchSelect.innerHTML = '<option value="">Loading branches...</option>';
});

// Create session button
createBtn?.addEventListener("click", () => {
  if (!selectedDirectory) {
    alert("Please select a project directory");
    return;
  }

  const config: SessionConfig = {
    projectDir: selectedDirectory,
    parentBranch: parentBranchSelect.value,
    codingAgent: codingAgentSelect.value,
  };

  // Save settings for next time
  ipcRenderer.send("save-settings", config);

  // Create the session
  ipcRenderer.send("create-session", config);
  modal?.classList.add("hidden");

  // Reset form
  projectDirInput.value = "";
  selectedDirectory = "";
  parentBranchSelect.innerHTML = '<option value="">Loading branches...</option>';
  codingAgentSelect.value = "claude";
});
