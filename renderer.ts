import { ipcRenderer } from "electron";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

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

interface Session {
  id: string;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  element: HTMLDivElement | null;
  name: string;
  config: SessionConfig;
  worktreePath: string;
  hasActivePty: boolean;
  hasUnreadActivity: boolean;
}

interface McpServer {
  name: string;
  connected?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: "stdio" | "sse";
}

interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  theme: string; // Theme preset name
  cursorBlink: boolean;
}

interface ThemeColors {
  background: string;
  foreground: string;
  cursor?: string;
  cursorAccent?: string;
  selection?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

// Theme presets
const THEME_PRESETS: Record<string, ThemeColors> = {
  "macos-light": {
    background: "#ffffff",
    foreground: "#000000",
    cursor: "#000000",
    selection: "#b4d5fe",
    black: "#000000",
    red: "#c23621",
    green: "#25bc24",
    yellow: "#adad27",
    blue: "#492ee1",
    magenta: "#d338d3",
    cyan: "#33bbc8",
    white: "#cbcccd",
    brightBlack: "#818383",
    brightRed: "#fc391f",
    brightGreen: "#31e722",
    brightYellow: "#eaec23",
    brightBlue: "#5833ff",
    brightMagenta: "#f935f8",
    brightCyan: "#14f0f0",
    brightWhite: "#e9ebeb",
  },
  "macos-dark": {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#ffffff",
    selection: "#4d4d4d",
    black: "#000000",
    red: "#c23621",
    green: "#25bc24",
    yellow: "#adad27",
    blue: "#492ee1",
    magenta: "#d338d3",
    cyan: "#33bbc8",
    white: "#cbcccd",
    brightBlack: "#818383",
    brightRed: "#fc391f",
    brightGreen: "#31e722",
    brightYellow: "#eaec23",
    brightBlue: "#5833ff",
    brightMagenta: "#f935f8",
    brightCyan: "#14f0f0",
    brightWhite: "#e9ebeb",
  },
  "solarized-dark": {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#839496",
    selection: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  "dracula": {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selection: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  "one-dark": {
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    selection: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  "github-dark": {
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#58a6ff",
    selection: "#163c61",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
};

// Detect system theme
function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Default settings - macOS Terminal matching system theme
const DEFAULT_SETTINGS: TerminalSettings = {
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 11,
  theme: getSystemTheme() === "dark" ? "macos-dark" : "macos-light",
  cursorBlink: false,
};

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;
let mcpServers: McpServer[] = [];
let terminalSettings: TerminalSettings = { ...DEFAULT_SETTINGS };

function createTerminalUI(sessionId: string) {
  const themeColors = THEME_PRESETS[terminalSettings.theme] || THEME_PRESETS["macos-dark"];

  const term = new Terminal({
    cursorBlink: terminalSettings.cursorBlink,
    fontSize: terminalSettings.fontSize,
    fontFamily: terminalSettings.fontFamily,
    theme: themeColors,
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

  // Listen for bell character to mark unread activity
  term.onBell(() => {
    if (activeSessionId !== sessionId) {
      markSessionAsUnread(sessionId);
    }
  });

  // Handle resize - only refit if dimensions actually changed
  let lastCols = term.cols;
  let lastRows = term.rows;
  let resizeTimeout: NodeJS.Timeout | null = null;

  const resizeHandler = () => {
    if (activeSessionId === sessionId) {
      // Clear any pending resize
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }

      // Debounce the fit call
      resizeTimeout = setTimeout(() => {
        // Calculate what the new dimensions would be
        const container = sessionElement;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const core = (term as any)._core;
        if (!core) return;

        // Estimate new dimensions based on container size
        const newCols = Math.floor(rect.width / core._renderService.dimensions.actualCellWidth);
        const newRows = Math.floor(rect.height / core._renderService.dimensions.actualCellHeight);

        // Only fit if dimensions actually changed significantly (more than 1 char difference)
        if (Math.abs(newCols - lastCols) > 1 || Math.abs(newRows - lastRows) > 1) {
          // Save scroll position before fitting
          const wasAtBottom = term.buffer.active.viewportY === term.buffer.active.baseY;
          const savedScrollPosition = term.buffer.active.viewportY;

          fitAddon.fit();

          lastCols = term.cols;
          lastRows = term.rows;

          // Restore scroll position unless we were at the bottom (in which case stay at bottom)
          if (!wasAtBottom && savedScrollPosition !== term.buffer.active.viewportY) {
            term.scrollToLine(savedScrollPosition);
          }

          ipcRenderer.send("session-resize", sessionId, term.cols, term.rows);
        }

        resizeTimeout = null;
      }, 100); // 100ms debounce
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
    hasUnreadActivity: false,
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
    <div class="flex items-center space-x-2 flex-1 session-name-container">
      <span class="session-indicator ${hasActivePty ? 'active' : ''}"></span>
      <span class="truncate session-name-text" data-id="${sessionId}">${name}</span>
      <input type="text" class="session-name-input hidden" data-id="${sessionId}" value="${name}" />
    </div>
    <button class="session-delete-btn" data-id="${sessionId}" title="Delete session">×</button>
  `;

  // Click on session name to edit
  const nameText = item.querySelector(".session-name-text");
  const nameInput = item.querySelector(".session-name-input") as HTMLInputElement;

  nameText?.addEventListener("click", (e) => {
    e.stopPropagation();
    startEditingSessionName(sessionId);
  });

  // Handle input blur and enter key
  nameInput?.addEventListener("blur", () => {
    finishEditingSessionName(sessionId);
  });

  nameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      finishEditingSessionName(sessionId);
    } else if (e.key === "Escape") {
      cancelEditingSessionName(sessionId);
    }
  });

  item.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("session-delete-btn") &&
        !target.classList.contains("session-name-text") &&
        !target.classList.contains("session-name-input")) {
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

function startEditingSessionName(sessionId: string) {
  const sidebarItem = document.getElementById(`sidebar-${sessionId}`);
  const nameText = sidebarItem?.querySelector(".session-name-text");
  const nameInput = sidebarItem?.querySelector(".session-name-input") as HTMLInputElement;

  if (nameText && nameInput) {
    nameText.classList.add("hidden");
    nameInput.classList.remove("hidden");
    nameInput.focus();
    nameInput.select();
  }
}

function finishEditingSessionName(sessionId: string) {
  const sidebarItem = document.getElementById(`sidebar-${sessionId}`);
  const nameText = sidebarItem?.querySelector(".session-name-text");
  const nameInput = sidebarItem?.querySelector(".session-name-input") as HTMLInputElement;
  const session = sessions.get(sessionId);

  if (nameText && nameInput && session) {
    const newName = nameInput.value.trim();
    if (newName && newName !== session.name) {
      // Update session name
      session.name = newName;
      nameText.textContent = newName;

      // Update tab name if exists
      const tab = document.getElementById(`tab-${sessionId}`);
      const tabName = tab?.querySelector(".tab-name");
      if (tabName) {
        tabName.textContent = newName;
      }

      // Save to backend
      ipcRenderer.send("rename-session", sessionId, newName);
    }

    nameInput.classList.add("hidden");
    nameText.classList.remove("hidden");
  }
}

function cancelEditingSessionName(sessionId: string) {
  const sidebarItem = document.getElementById(`sidebar-${sessionId}`);
  const nameText = sidebarItem?.querySelector(".session-name-text");
  const nameInput = sidebarItem?.querySelector(".session-name-input") as HTMLInputElement;
  const session = sessions.get(sessionId);

  if (nameText && nameInput && session) {
    // Reset to original name
    nameInput.value = session.name;
    nameInput.classList.add("hidden");
    nameText.classList.remove("hidden");
  }
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

function markSessionAsUnread(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.hasUnreadActivity = true;

  // Add unread indicator to tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.add("unread");
  }
}

function clearUnreadStatus(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.hasUnreadActivity = false;

  // Remove unread indicator from tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.remove("unread");
  }
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

    // Clear unread status when switching to this session
    clearUnreadStatus(sessionId);

    // Clear any pending idle timer for this session (Bug 1 fix)
    const existingTimer = sessionIdleTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      sessionIdleTimers.delete(sessionId);
    }

    // Focus and resize
    session.terminal.focus();
    setTimeout(() => {
      if (session.fitAddon && session.terminal) {
        // Save scroll position before fitting
        const wasAtBottom = session.terminal.buffer.active.viewportY === session.terminal.buffer.active.baseY;
        const savedScrollPosition = session.terminal.buffer.active.viewportY;

        session.fitAddon.fit();

        // Restore scroll position unless we were at the bottom
        if (!wasAtBottom && savedScrollPosition !== session.terminal.buffer.active.viewportY) {
          session.terminal.scrollToLine(savedScrollPosition);
        }

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

  // Clean up idle timer (Bug 2 fix)
  const existingTimer = sessionIdleTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionIdleTimers.delete(sessionId);
  }

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

  // Clean up idle timer (Bug 2 fix)
  const existingTimer = sessionIdleTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionIdleTimers.delete(sessionId);
  }

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

// Track idle timers per session to detect when output stops (Claude is done)
const sessionIdleTimers = new Map<string, NodeJS.Timeout>();
const IDLE_DELAY_MS = 500; // 0.5 seconds of no output = Claude is done

// Handle session output
ipcRenderer.on("session-output", (_event, sessionId: string, data: string) => {
  const session = sessions.get(sessionId);
  if (session && session.terminal) {
    // Filter out [3J (clear scrollback) to prevent viewport resets during interactive menus
    // Keep [2J (clear screen) which is needed for the menu redraw
    const filteredData = data.replace(/\x1b\[3J/g, '');

    session.terminal.write(filteredData);

    // Only mark as unread if this is not the active session
    if (activeSessionId !== sessionId && session.hasActivePty && !session.hasUnreadActivity) {
      // Only track substantive output (ignore cursor movements, keepalives, etc)
      // Look for actual text content or common escape sequences that indicate real output
      const hasSubstantiveOutput = /[a-zA-Z0-9]/.test(filteredData) ||
                                    filteredData.includes('\n') ||
                                    filteredData.includes('\r');

      if (hasSubstantiveOutput) {
        // Clear any existing idle timer
        const existingTimer = sessionIdleTimers.get(sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        // Set a new timer - if no output for IDLE_DELAY_MS, mark as unread
        const timer = setTimeout(() => {
          markSessionAsUnread(sessionId);
          sessionIdleTimers.delete(sessionId);
        }, IDLE_DELAY_MS);

        sessionIdleTimers.set(sessionId, timer);
      }
    }
  }
});

// Handle session created
ipcRenderer.on("session-created", (_event, sessionId: string, persistedSession: any) => {
  const session = addSession(persistedSession, true);
  activateSession(sessionId);

  // Reset button state and close modal
  const createBtn = document.getElementById("create-session") as HTMLButtonElement;
  const modal = document.getElementById("config-modal");
  const projectDirInput = document.getElementById("project-dir") as HTMLInputElement;
  const parentBranchSelect = document.getElementById("parent-branch") as HTMLSelectElement;
  const setupCommandsTextarea = document.getElementById("setup-commands") as HTMLTextAreaElement;

  if (createBtn) {
    createBtn.disabled = false;
    createBtn.textContent = "Create Session";
    createBtn.classList.remove("loading");
  }

  modal?.classList.add("hidden");

  // Reset form
  projectDirInput.value = "";
  selectedDirectory = "";
  parentBranchSelect.innerHTML = '<option value="">Loading branches...</option>';
  if (setupCommandsTextarea) {
    setupCommandsTextarea.value = "";
  }
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
const skipPermissionsCheckbox = document.getElementById("skip-permissions") as HTMLInputElement;
const skipPermissionsGroup = skipPermissionsCheckbox?.parentElement?.parentElement;
const browseDirBtn = document.getElementById("browse-dir");
const cancelBtn = document.getElementById("cancel-session");
const createBtn = document.getElementById("create-session") as HTMLButtonElement;

let selectedDirectory = "";

// Toggle skip permissions checkbox visibility based on coding agent
codingAgentSelect?.addEventListener("change", () => {
  if (codingAgentSelect.value === "claude") {
    skipPermissionsGroup?.classList.remove("hidden");
  } else {
    skipPermissionsGroup?.classList.add("hidden");
  }
});

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

  // Set last used skip permissions setting and visibility
  if (lastSettings.skipPermissions !== undefined) {
    skipPermissionsCheckbox.checked = lastSettings.skipPermissions;
  }

  // Set last used setup commands
  const setupCommandsTextarea = document.getElementById("setup-commands") as HTMLTextAreaElement;
  if (lastSettings.setupCommands && setupCommandsTextarea) {
    setupCommandsTextarea.value = lastSettings.setupCommands.join("\n");
  }

  // Show/hide skip permissions based on coding agent
  if (lastSettings.codingAgent === "codex") {
    skipPermissionsGroup?.classList.add("hidden");
  } else {
    skipPermissionsGroup?.classList.remove("hidden");
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

  const setupCommandsTextarea = document.getElementById("setup-commands") as HTMLTextAreaElement;
  const setupCommandsText = setupCommandsTextarea?.value.trim();
  const setupCommands = setupCommandsText
    ? setupCommandsText.split("\n").filter(cmd => cmd.trim())
    : undefined;

  const config: SessionConfig = {
    projectDir: selectedDirectory,
    parentBranch: parentBranchSelect.value,
    codingAgent: codingAgentSelect.value,
    skipPermissions: codingAgentSelect.value === "claude" ? skipPermissionsCheckbox.checked : false,
    setupCommands,
  };

  // Show loading state
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.innerHTML = '<span class="loading-spinner"></span> Creating...';
    createBtn.classList.add("loading");
  }

  // Save settings for next time
  ipcRenderer.send("save-settings", config);

  // Create the session
  ipcRenderer.send("create-session", config);
});

// MCP Server management functions
async function loadMcpServers() {
  const addMcpServerBtn = document.getElementById("add-mcp-server");

  // Show loading spinner
  if (addMcpServerBtn) {
    addMcpServerBtn.innerHTML = '<span class="loading-spinner"></span>';
    addMcpServerBtn.classList.add("pointer-events-none");
  }

  try {
    const servers = await ipcRenderer.invoke("list-mcp-servers");
    mcpServers = servers;
    renderMcpServers();
  } catch (error) {
    console.error("Failed to load MCP servers:", error);
  } finally {
    // Restore button
    if (addMcpServerBtn) {
      addMcpServerBtn.innerHTML = '+';
      addMcpServerBtn.classList.remove("pointer-events-none");
    }
  }
}

function renderMcpServers() {
  const list = document.getElementById("mcp-server-list");
  if (!list) return;

  list.innerHTML = "";

  mcpServers.forEach(server => {
    const item = document.createElement("div");
    item.className = "session-list-item";
    const indicatorClass = server.connected ? "active" : "disconnected";
    item.innerHTML = `
      <div class="flex items-center space-x-2 flex-1">
        <span class="session-indicator ${indicatorClass}"></span>
        <span class="truncate">${server.name}</span>
      </div>
      <button class="session-delete-btn mcp-remove-btn" data-name="${server.name}" title="Remove server">×</button>
    `;

    // Click to show details
    item.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("mcp-remove-btn")) {
        await showMcpServerDetails(server.name);
      }
    });

    const removeBtn = item.querySelector(".mcp-remove-btn");
    removeBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`Remove MCP server "${server.name}"?`)) {
        try {
          await ipcRenderer.invoke("remove-mcp-server", server.name);
          await loadMcpServers();
        } catch (error) {
          alert(`Failed to remove server: ${error}`);
        }
      }
    });

    list.appendChild(item);
  });
}

async function showMcpServerDetails(name: string) {
  const detailsModal = document.getElementById("mcp-details-modal");
  const detailsTitle = document.getElementById("mcp-details-title");
  const detailsContent = document.getElementById("mcp-details-content");

  // Show modal immediately with loading state
  if (detailsTitle) {
    detailsTitle.textContent = name;
  }

  if (detailsContent) {
    detailsContent.innerHTML = '<div class="flex items-center justify-center py-8"><span class="loading-spinner" style="width: 24px; height: 24px; border-width: 3px;"></span></div>';
  }

  detailsModal?.classList.remove("hidden");

  try {
    const details = await ipcRenderer.invoke("get-mcp-server-details", name);

    if (detailsContent) {
      let html = "";
      if (details.scope) {
        html += `<div><strong>Scope:</strong> ${details.scope}</div>`;
      }
      if (details.status) {
        html += `<div><strong>Status:</strong> ${details.status}</div>`;
      }
      if (details.type) {
        html += `<div><strong>Type:</strong> ${details.type}</div>`;
      }
      if (details.url) {
        html += `<div><strong>URL:</strong> ${details.url}</div>`;
      }
      if (details.command) {
        html += `<div><strong>Command:</strong> ${details.command}</div>`;
      }
      if (details.args) {
        html += `<div><strong>Args:</strong> ${details.args}</div>`;
      }

      detailsContent.innerHTML = html;
    }

    // Store current server name for remove button
    const removeMcpDetailsBtn = document.getElementById("remove-mcp-details") as HTMLButtonElement;
    if (removeMcpDetailsBtn) {
      removeMcpDetailsBtn.dataset.serverName = name;
    }
  } catch (error) {
    console.error("Failed to get server details:", error);
    if (detailsContent) {
      detailsContent.innerHTML = `<div class="text-red-400">Failed to load server details</div>`;
    }
  }
}

// MCP Modal handling
const mcpModal = document.getElementById("mcp-modal");
const mcpNameInput = document.getElementById("mcp-name") as HTMLInputElement;
const mcpTypeSelect = document.getElementById("mcp-type") as HTMLSelectElement;
const mcpCommandInput = document.getElementById("mcp-command") as HTMLInputElement;
const mcpArgsInput = document.getElementById("mcp-args") as HTMLInputElement;
const mcpEnvInput = document.getElementById("mcp-env") as HTMLTextAreaElement;
const mcpUrlInput = document.getElementById("mcp-url") as HTMLInputElement;
const mcpHeadersInput = document.getElementById("mcp-headers") as HTMLTextAreaElement;
const mcpAlwaysAllowInput = document.getElementById("mcp-always-allow") as HTMLInputElement;
const localFields = document.getElementById("local-fields");
const remoteFields = document.getElementById("remote-fields");
const cancelMcpBtn = document.getElementById("cancel-mcp");
const addMcpBtn = document.getElementById("add-mcp") as HTMLButtonElement;

// Toggle fields based on server type
mcpTypeSelect?.addEventListener("change", () => {
  if (mcpTypeSelect.value === "local") {
    localFields!.style.display = "block";
    remoteFields!.style.display = "none";
  } else {
    localFields!.style.display = "none";
    remoteFields!.style.display = "block";
  }
});

// Add MCP server button - opens modal
document.getElementById("add-mcp-server")?.addEventListener("click", () => {
  mcpModal?.classList.remove("hidden");
  mcpNameInput.value = "";
  mcpTypeSelect.value = "local";
  mcpCommandInput.value = "";
  mcpArgsInput.value = "";
  mcpEnvInput.value = "";
  mcpUrlInput.value = "";
  mcpHeadersInput.value = "";
  mcpAlwaysAllowInput.value = "";
  localFields!.style.display = "block";
  remoteFields!.style.display = "none";
});

// Cancel MCP button
cancelMcpBtn?.addEventListener("click", () => {
  mcpModal?.classList.add("hidden");
});

// Add MCP button
addMcpBtn?.addEventListener("click", async () => {
  const name = mcpNameInput.value.trim();
  const serverType = mcpTypeSelect.value;

  if (!name) {
    alert("Please enter a server name");
    return;
  }

  const config: any = {};

  if (serverType === "local") {
    config.type = "stdio";

    const command = mcpCommandInput.value.trim();
    const argsInput = mcpArgsInput.value.trim();

    if (!command) {
      alert("Please enter a command");
      return;
    }

    config.command = command;
    if (argsInput) {
      config.args = argsInput.split(" ").filter(a => a.trim());
    }

    // Parse environment variables if provided
    const envInput = mcpEnvInput.value.trim();
    if (envInput) {
      try {
        config.env = JSON.parse(envInput);
      } catch (error) {
        alert("Invalid JSON for environment variables");
        return;
      }
    }
  } else {
    // Remote server
    config.type = "sse";

    const url = mcpUrlInput.value.trim();

    if (!url) {
      alert("Please enter a server URL");
      return;
    }

    config.url = url;

    // Parse headers if provided
    const headersInput = mcpHeadersInput.value.trim();
    if (headersInput) {
      try {
        config.headers = JSON.parse(headersInput);
      } catch (error) {
        alert("Invalid JSON for headers");
        return;
      }
    }
  }

  // Parse always allow tools
  const alwaysAllowInput = mcpAlwaysAllowInput.value.trim();
  if (alwaysAllowInput) {
    config.alwaysAllow = alwaysAllowInput.split(",").map(t => t.trim()).filter(t => t);
  }

  // Show loading state
  const originalText = addMcpBtn.textContent;
  addMcpBtn.textContent = "Adding...";
  addMcpBtn.disabled = true;
  addMcpBtn.classList.add("opacity-50", "cursor-not-allowed");

  try {
    await ipcRenderer.invoke("add-mcp-server", name, config);
    await loadMcpServers();
    mcpModal?.classList.add("hidden");
  } catch (error) {
    console.error("Error adding server:", error);
    alert(`Failed to add server: ${error}`);
  } finally {
    // Reset button state
    addMcpBtn.textContent = originalText;
    addMcpBtn.disabled = false;
    addMcpBtn.classList.remove("opacity-50", "cursor-not-allowed");
  }
});

// MCP Details Modal handling
const closeMcpDetailsBtn = document.getElementById("close-mcp-details");
const removeMcpDetailsBtn = document.getElementById("remove-mcp-details") as HTMLButtonElement;
const mcpDetailsModal = document.getElementById("mcp-details-modal");

closeMcpDetailsBtn?.addEventListener("click", () => {
  mcpDetailsModal?.classList.add("hidden");
});

removeMcpDetailsBtn?.addEventListener("click", async () => {
  const serverName = removeMcpDetailsBtn.dataset.serverName;
  if (!serverName) return;

  if (confirm(`Remove MCP server "${serverName}"?`)) {
    try {
      await ipcRenderer.invoke("remove-mcp-server", serverName);
      mcpDetailsModal?.classList.add("hidden");
      await loadMcpServers();
    } catch (error) {
      alert(`Failed to remove server: ${error}`);
    }
  }
});

// Listen for MCP server updates from main process
ipcRenderer.on("mcp-servers-updated", (_event, servers: McpServer[]) => {
  mcpServers = servers;
  renderMcpServers();
});

// Load MCP servers on startup
loadMcpServers();

// Settings Modal handling
const settingsModal = document.getElementById("settings-modal");
const openSettingsBtn = document.getElementById("open-settings");
const cancelSettingsBtn = document.getElementById("cancel-settings");
const resetSettingsBtn = document.getElementById("reset-settings");
const saveSettingsBtn = document.getElementById("save-settings");

const settingsTheme = document.getElementById("settings-theme") as HTMLSelectElement;
const settingsFontFamily = document.getElementById("settings-font-family") as HTMLSelectElement;
const settingsFontSize = document.getElementById("settings-font-size") as HTMLInputElement;
const settingsCursorBlink = document.getElementById("settings-cursor-blink") as HTMLInputElement;

// Load saved settings on startup
async function loadSettings() {
  const savedSettings = await ipcRenderer.invoke("get-terminal-settings");
  if (savedSettings) {
    terminalSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
  }
}

// Populate settings form
function populateSettingsForm() {
  // Set theme
  settingsTheme.value = terminalSettings.theme;

  // Set font family - match against dropdown options
  const fontOptions = Array.from(settingsFontFamily.options);
  const matchingOption = fontOptions.find(opt => opt.value === terminalSettings.fontFamily);
  if (matchingOption) {
    settingsFontFamily.value = matchingOption.value;
  } else {
    // Default to first option (Menlo) if no match
    settingsFontFamily.selectedIndex = 0;
  }

  settingsFontSize.value = terminalSettings.fontSize.toString();
  settingsCursorBlink.checked = terminalSettings.cursorBlink;
}

// Apply settings to all existing terminals
function applySettingsToAllTerminals() {
  const themeColors = THEME_PRESETS[terminalSettings.theme] || THEME_PRESETS["macos-dark"];

  sessions.forEach((session) => {
    if (session.terminal) {
      session.terminal.options.fontFamily = terminalSettings.fontFamily;
      session.terminal.options.fontSize = terminalSettings.fontSize;
      session.terminal.options.cursorBlink = terminalSettings.cursorBlink;
      session.terminal.options.theme = themeColors;

      // Refresh terminal to apply changes
      if (session.fitAddon) {
        session.fitAddon.fit();
      }
    }
  });
}

// Open settings modal
openSettingsBtn?.addEventListener("click", () => {
  populateSettingsForm();
  settingsModal?.classList.remove("hidden");
});

// Cancel settings
cancelSettingsBtn?.addEventListener("click", () => {
  settingsModal?.classList.add("hidden");
});

// Reset settings to default
resetSettingsBtn?.addEventListener("click", () => {
  terminalSettings = { ...DEFAULT_SETTINGS };
  populateSettingsForm();
});

// Save settings
saveSettingsBtn?.addEventListener("click", async () => {
  // Read values from form
  terminalSettings.theme = settingsTheme.value;
  terminalSettings.fontFamily = settingsFontFamily.value || DEFAULT_SETTINGS.fontFamily;
  terminalSettings.fontSize = parseInt(settingsFontSize.value) || DEFAULT_SETTINGS.fontSize;
  terminalSettings.cursorBlink = settingsCursorBlink.checked;

  // Save to electron-store
  await ipcRenderer.invoke("save-terminal-settings", terminalSettings);

  // Apply to all existing terminals
  applySettingsToAllTerminals();

  // Close modal
  settingsModal?.classList.add("hidden");
});

// Load settings on startup
loadSettings();
