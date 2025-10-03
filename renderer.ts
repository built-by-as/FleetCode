import { ipcRenderer } from "electron";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

interface SessionConfig {
  projectDir: string;
  parentBranch: string;
  codingAgent: string;
}

interface PersistedSession {
  id: string;
  number: number;
  name: string;
  config: SessionConfig;
  worktreePath: string;
  createdAt: number;
}

interface Session {
  id: string;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  element: HTMLDivElement | null;
  name: string;
  config: SessionConfig;
  worktreePath: string;
  hasActivePty: boolean;
}

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;

function createTerminalUI(sessionId: string) {
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

  // Handle resize
  const resizeHandler = () => {
    if (activeSessionId === sessionId) {
      fitAddon.fit();
      ipcRenderer.send("session-resize", sessionId, term.cols, term.rows);
    }
  };
  window.addEventListener("resize", resizeHandler);

  return { terminal: term, fitAddon, element: sessionElement };
}

function addSession(persistedSession: PersistedSession, hasActivePty: boolean) {
  const session: Session = {
    id: persistedSession.id,
    terminal: null,
    fitAddon: null,
    element: null,
    name: persistedSession.name,
    config: persistedSession.config,
    worktreePath: persistedSession.worktreePath,
    hasActivePty,
  };

  sessions.set(persistedSession.id, session);

  // Add to sidebar
  addToSidebar(persistedSession.id, persistedSession.name, hasActivePty);

  // Only add tab if terminal is active
  if (hasActivePty) {
    addTab(persistedSession.id, persistedSession.name);
  }

  return session;
}

function activateSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // If terminal UI doesn't exist yet, create it
  if (!session.terminal) {
    const ui = createTerminalUI(sessionId);
    session.terminal = ui.terminal;
    session.fitAddon = ui.fitAddon;
    session.element = ui.element;
  }

  session.hasActivePty = true;
  updateSessionState(sessionId, true);

  // Add tab if it doesn't exist
  if (!document.getElementById(`tab-${sessionId}`)) {
    addTab(sessionId, session.name);
  }

  // Switch to this session
  switchToSession(sessionId);
}

function updateSessionState(sessionId: string, isActive: boolean) {
  const sidebarItem = document.getElementById(`sidebar-${sessionId}`);
  const indicator = sidebarItem?.querySelector(".session-indicator");

  if (indicator) {
    if (isActive) {
      indicator.classList.add("active");
    } else {
      indicator.classList.remove("active");
    }
  }
}

function addToSidebar(sessionId: string, name: string, hasActivePty: boolean) {
  const list = document.getElementById("session-list");
  if (!list) return;

  const item = document.createElement("div");
  item.id = `sidebar-${sessionId}`;
  item.className = "session-list-item";
  item.innerHTML = `
    <div class="flex items-center space-x-2 flex-1">
      <span class="session-indicator ${hasActivePty ? 'active' : ''}"></span>
      <span class="truncate">${name}</span>
    </div>
    <button class="session-delete-btn" data-id="${sessionId}" title="Delete session">×</button>
  `;

  item.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("session-delete-btn")) {
      handleSessionClick(sessionId);
    }
  });

  const deleteBtn = item.querySelector(".session-delete-btn");
  deleteBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteSession(sessionId);
  });

  list.appendChild(item);
}

function handleSessionClick(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.hasActivePty) {
    // Just switch to it
    switchToSession(sessionId);
  } else {
    // Reopen the session
    ipcRenderer.send("reopen-session", sessionId);
  }
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
    if (session.element) {
      session.element.classList.remove("active");
    }
    document.getElementById(`tab-${id}`)?.classList.remove("active");
    document.getElementById(`sidebar-${id}`)?.classList.remove("active");
  });

  // Show active session
  const session = sessions.get(sessionId);
  if (session && session.element && session.terminal && session.fitAddon) {
    session.element.classList.add("active");
    document.getElementById(`tab-${sessionId}`)?.classList.add("active");
    document.getElementById(`sidebar-${sessionId}`)?.classList.add("active");
    activeSessionId = sessionId;

    // Focus and resize
    session.terminal.focus();
    setTimeout(() => {
      if (session.fitAddon && session.terminal) {
        session.fitAddon.fit();
        ipcRenderer.send("session-resize", sessionId, session.terminal.cols, session.terminal.rows);
      }
    }, 0);
  }
}

function closeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Remove terminal UI
  if (session.element) {
    session.element.remove();
  }
  if (session.terminal) {
    session.terminal.dispose();
  }

  // Remove tab
  document.getElementById(`tab-${sessionId}`)?.remove();

  // Update session state
  session.terminal = null;
  session.fitAddon = null;
  session.element = null;
  session.hasActivePty = false;

  // Update UI indicator
  updateSessionState(sessionId, false);

  // Close PTY in main process
  ipcRenderer.send("close-session", sessionId);

  // Switch to another active session
  if (activeSessionId === sessionId) {
    const activeSessions = Array.from(sessions.values()).filter(s => s.hasActivePty);
    if (activeSessions.length > 0) {
      switchToSession(activeSessions[0].id);
    } else {
      activeSessionId = null;
    }
  }
}

function deleteSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Confirm deletion
  if (!confirm(`Delete ${session.name}? This will remove the git worktree.`)) {
    return;
  }

  // Remove from UI
  if (session.element) {
    session.element.remove();
  }
  if (session.terminal) {
    session.terminal.dispose();
  }
  document.getElementById(`tab-${sessionId}`)?.remove();
  document.getElementById(`sidebar-${sessionId}`)?.remove();

  // Remove from sessions map
  sessions.delete(sessionId);

  // Delete in main process (handles worktree removal)
  ipcRenderer.send("delete-session", sessionId);

  // Switch to another session
  if (activeSessionId === sessionId) {
    const remainingSessions = Array.from(sessions.values()).filter(s => s.hasActivePty);
    if (remainingSessions.length > 0) {
      switchToSession(remainingSessions[0].id);
    } else {
      activeSessionId = null;
    }
  }
}

// Handle session output
ipcRenderer.on("session-output", (_event, sessionId: string, data: string) => {
  const session = sessions.get(sessionId);
  if (session && session.terminal) {
    session.terminal.write(data);
  }
});

// Handle session created
ipcRenderer.on("session-created", (_event, sessionId: string, persistedSession: any) => {
  const session = addSession(persistedSession, true);
  activateSession(sessionId);
});

// Handle session reopened
ipcRenderer.on("session-reopened", (_event, sessionId: string) => {
  activateSession(sessionId);
});

// Handle session deleted
ipcRenderer.on("session-deleted", (_event, sessionId: string) => {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.element) session.element.remove();
    if (session.terminal) session.terminal.dispose();
    document.getElementById(`tab-${sessionId}`)?.remove();
    document.getElementById(`sidebar-${sessionId}`)?.remove();
    sessions.delete(sessionId);

    if (activeSessionId === sessionId) {
      const remainingSessions = Array.from(sessions.values()).filter(s => s.hasActivePty);
      if (remainingSessions.length > 0) {
        switchToSession(remainingSessions[0].id);
      } else {
        activeSessionId = null;
      }
    }
  }
});

// Load persisted sessions on startup
ipcRenderer.on("load-persisted-sessions", (_event, persistedSessions: PersistedSession[]) => {
  persistedSessions.forEach(ps => {
    addSession(ps, false);
  });
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
