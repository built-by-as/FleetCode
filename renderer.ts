import {FitAddon} from "@xterm/addon-fit";
import {ipcRenderer} from "electron";
import {Terminal} from "xterm";
import {PersistedSession, SessionConfig, SessionType} from "./types";
import {isClaudeSessionReady} from "./terminal-utils";
import * as path from "path";

interface Session {
  id: string;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  element: HTMLDivElement | null;
  name: string;
  config: SessionConfig;
  worktreePath?: string;
  hasActivePty: boolean;
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
  worktreeDir: string;
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
  worktreeDir: require("path").join(require("os").homedir(), "worktrees"),
};

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;
let mcpServers: McpServer[] = [];
let mcpPollerActive = false;
let terminalSettings: TerminalSettings = { ...DEFAULT_SETTINGS };

// Track activity timers for each session
const activityTimers = new Map<string, NodeJS.Timeout>();

async function loadAndPopulateBranches(
  directory: string,
  selectedBranch?: string
): Promise<void> {
  const branches = await ipcRenderer.invoke("get-branches", directory);
  existingBranches = branches;
  parentBranchSelect.innerHTML = "";

  if (branches.length === 0) {
    parentBranchSelect.innerHTML = '<option value="">No git repository found</option>';
  } else {
    branches.forEach((branch: string) => {
      const option = document.createElement("option");
      option.value = branch;
      option.textContent = branch;
      if (branch === selectedBranch) {
        option.selected = true;
      }
      parentBranchSelect.appendChild(option);
    });
  }
}

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

  term.onData((data) => {
    ipcRenderer.send("session-input", sessionId, data);
  });

  // Listen for bell character to mark unread activity
  term.onBell(() => {
    if (activeSessionId !== sessionId) {
      markSessionAsUnread(sessionId);
    }
  });

  const resizeHandler = () => {
    if (activeSessionId === sessionId) {
      const proposedDimensions = fitAddon.proposeDimensions();
      if (proposedDimensions) {
        fitAddon.fit();
        ipcRenderer.send("session-resize", sessionId, proposedDimensions.cols, proposedDimensions.rows);
      }
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
    <div class="flex items-center space-x-2 flex-1 session-name-container">
      <span class="session-indicator ${hasActivePty ? 'active' : ''}"></span>
      <span class="truncate session-name-text" data-id="${sessionId}">${name}</span>
      <input type="text" class="session-name-input hidden" data-id="${sessionId}" value="${name}" />
    </div>
    <div class="relative">
      <button class="session-menu-btn" data-id="${sessionId}" title="Session options">⋯</button>
      <div class="session-menu hidden" data-id="${sessionId}">
        <button class="session-menu-item rename-session-btn" data-id="${sessionId}">Rename</button>
        <button class="session-menu-item delete-session-btn" data-id="${sessionId}">Delete</button>
      </div>
    </div>
  `;

  // Handle input blur and enter key
  const nameInput = item.querySelector(".session-name-input") as HTMLInputElement;
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

  // Click on item to activate session
  item.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("session-menu-btn") &&
        !target.classList.contains("session-menu-item") &&
        !target.classList.contains("session-name-input") &&
        !target.closest(".session-menu")) {
      handleSessionClick(sessionId);
    }
  });

  // Menu button toggle
  const menuBtn = item.querySelector(".session-menu-btn");
  const menu = item.querySelector(".session-menu") as HTMLElement;

  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();

    // Close all other menus
    document.querySelectorAll(".session-menu").forEach(m => {
      if (m !== menu) m.classList.add("hidden");
    });

    // Toggle this menu
    menu?.classList.toggle("hidden");
  });

  // Rename button
  const renameBtn = item.querySelector(".rename-session-btn");
  renameBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
    startEditingSessionName(sessionId);
  });

  // Delete button
  const deleteBtn = item.querySelector(".delete-session-btn");
  deleteBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
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
    <span class="unread-indicator"></span>
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

  // Add unread indicator to tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.add("unread");
  }
}

function clearUnreadStatus(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Remove unread indicator from tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.remove("unread");
  }
}

function markSessionActivity(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Add activity indicator to tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.add("activity");
    tab.classList.remove("unread");
  }

  // Clear any existing timer
  const existingTimer = activityTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set a new timer to remove activity after 1 second of no output
  const timer = setTimeout(() => {
    clearActivityStatus(sessionId);
  }, 1000);

  activityTimers.set(sessionId, timer);
}

function clearActivityStatus(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Remove activity indicator from tab, but keep unread if it's set
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.remove("activity");
    // If there's no unread status, transition to unread after activity ends
    if (!tab.classList.contains("unread") && activeSessionId !== sessionId) {
      tab.classList.add("unread");
    }
  }

  // Clear the timer
  activityTimers.delete(sessionId);
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

    // Show MCP section when a session is active
    const mcpSection = document.getElementById("mcp-section");
    if (mcpSection) {
      mcpSection.style.display = "block";
    }

    // Clear MCP servers from previous session and re-render
    mcpServers = [];
    renderMcpServers();

    // Load MCP servers for this session
    loadMcpServers();

    // Clear unread and activity status when switching to this session
    clearUnreadStatus(sessionId);
    clearActivityStatus(sessionId);

    // Focus and resize
    session.terminal.focus();
    // Dispatch resize event to trigger terminal resize
    window.dispatchEvent(new Event("resize"));
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
      // Hide MCP section when no sessions are active
      const mcpSection = document.getElementById("mcp-section");
      if (mcpSection) {
        mcpSection.style.display = "none";
      }
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
      // Hide MCP section when no sessions are active
      const mcpSection = document.getElementById("mcp-section");
      if (mcpSection) {
        mcpSection.style.display = "none";
      }
    }
  }
}

// Handle session output
ipcRenderer.on("session-output", (_event, sessionId: string, data: string) => {
  const session = sessions.get(sessionId);
  if (session && session.terminal) {
    // Filter out [3J (clear scrollback) to prevent viewport resets during interactive menus
    // Keep [2J (clear screen) which is needed for the menu redraw
    const filteredData = data.replace(/\x1b\[3J/g, '');

    session.terminal.write(filteredData);

    // Only mark as unread/activity if this is not the active session
    if (activeSessionId !== sessionId && session.hasActivePty) {
      // Show activity spinner while output is coming in
      markSessionActivity(sessionId);

      // Check if Claude session is ready for input
      if (isClaudeSessionReady(filteredData)) {
        // Clear activity timer and set unread
        const existingTimer = activityTimers.get(sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          activityTimers.delete(sessionId);
        }

        const tab = document.getElementById(`tab-${sessionId}`);
        if (tab) {
          tab.classList.remove("activity");
          tab.classList.add("unread");
        }
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
  const branchNameInput = document.getElementById("branch-name") as HTMLInputElement;
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
  if (branchNameInput) {
    branchNameInput.value = "";
  }
  if (setupCommandsTextarea) {
    setupCommandsTextarea.value = "";
  }

  // Reset validation state
  const branchNameError = document.getElementById("branch-name-error");
  const branchNameHelp = document.getElementById("branch-name-help");
  branchNameError?.classList.add("hidden");
  branchNameHelp?.classList.remove("hidden");
  existingBranches = [];
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
const sessionTypeSelect = document.getElementById("session-type") as HTMLSelectElement;
const parentBranchGroup = document.getElementById("parent-branch-group");
const branchNameGroup = document.getElementById("branch-name-group");
const worktreeDescription = document.getElementById("worktree-description");
const localDescription = document.getElementById("local-description");
const browseDirBtn = document.getElementById("browse-dir");
const cancelBtn = document.getElementById("cancel-session");
const createBtn = document.getElementById("create-session") as HTMLButtonElement;
const branchNameInput = document.getElementById("branch-name") as HTMLInputElement;
const branchNameError = document.getElementById("branch-name-error");
const branchNameHelp = document.getElementById("branch-name-help");

let selectedDirectory = "";
let existingBranches: string[] = [];

// Validate branch name
function validateBranchName(): boolean {
  const branchName = branchNameInput?.value.trim();

  if (!branchName) {
    // Empty branch name is allowed (it's optional)
    branchNameError?.classList.add("hidden");
    branchNameHelp?.classList.remove("hidden");
    return true;
  }

  // Check if branch already exists
  const branchExists = existingBranches.some(branch =>
    branch === branchName || branch === `origin/${branchName}`
  );

  if (branchExists) {
    branchNameError?.classList.remove("hidden");
    branchNameHelp?.classList.add("hidden");
    return false;
  } else {
    branchNameError?.classList.add("hidden");
    branchNameHelp?.classList.remove("hidden");
    return true;
  }
}

// Add input event listener for branch name validation
branchNameInput?.addEventListener("input", () => {
  validateBranchName();
});

// Toggle skip permissions checkbox visibility based on coding agent
codingAgentSelect?.addEventListener("change", () => {
  if (codingAgentSelect.value === "claude") {
    skipPermissionsGroup?.classList.remove("hidden");
  } else {
    skipPermissionsGroup?.classList.add("hidden");
  }
});

// Toggle parent branch and branch name visibility based on session type
sessionTypeSelect?.addEventListener("change", () => {
  const isWorktree = sessionTypeSelect.value === SessionType.WORKTREE;
  if (isWorktree) {
    parentBranchGroup?.classList.remove("hidden");
    branchNameGroup?.classList.remove("hidden");
    worktreeDescription?.style.setProperty("display", "block");
    localDescription?.style.setProperty("display", "none");
  } else {
    parentBranchGroup?.classList.add("hidden");
    branchNameGroup?.classList.add("hidden");
    worktreeDescription?.style.setProperty("display", "none");
    localDescription?.style.setProperty("display", "block");
  }
});

// New session button - opens modal
document.getElementById("new-session")?.addEventListener("click", async () => {
  modal?.classList.remove("hidden");

  // Load last used settings
  const lastSettings = await ipcRenderer.invoke("get-last-settings");

  if (lastSettings.projectDir) {
    selectedDirectory = lastSettings.projectDir;
    // Show last part of path in parentheses before full path
    const dirName = path.basename(lastSettings.projectDir);
    projectDirInput.value = `(${dirName}) ${lastSettings.projectDir}`;

    // Load git branches for the last directory
    await loadAndPopulateBranches(lastSettings.projectDir, lastSettings.parentBranch);
  }

  // Set last used session type (default to worktree if not set)
  if (lastSettings.sessionType) {
    sessionTypeSelect.value = lastSettings.sessionType;
  } else {
    sessionTypeSelect.value = SessionType.WORKTREE;
  }

  // Show/hide parent branch, branch name, and descriptions based on session type
  const isWorktree = sessionTypeSelect.value === SessionType.WORKTREE;
  if (isWorktree) {
    parentBranchGroup?.classList.remove("hidden");
    branchNameGroup?.classList.remove("hidden");
    worktreeDescription?.style.setProperty("display", "block");
    localDescription?.style.setProperty("display", "none");
  } else {
    parentBranchGroup?.classList.add("hidden");
    branchNameGroup?.classList.add("hidden");
    worktreeDescription?.style.setProperty("display", "none");
    localDescription?.style.setProperty("display", "block");
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
    // Show last part of path in parentheses before full path
    const dirName = path.basename(dir);
    projectDirInput.value = `(${dirName}) ${dir}`;

    // Load git branches
    await loadAndPopulateBranches(dir);
  }
});

// Cancel button
cancelBtn?.addEventListener("click", () => {
  modal?.classList.add("hidden");
  projectDirInput.value = "";
  selectedDirectory = "";
  parentBranchSelect.innerHTML = '<option value="">Loading branches...</option>';
  branchNameInput.value = "";
  branchNameError?.classList.add("hidden");
  branchNameHelp?.classList.remove("hidden");
  existingBranches = [];
});

// Create session button
createBtn?.addEventListener("click", () => {
  if (!selectedDirectory) {
    alert("Please select a project directory");
    return;
  }

  const sessionType = sessionTypeSelect.value as SessionType;

  // Validate parent branch is selected for worktree sessions
  if (sessionType === SessionType.WORKTREE && !parentBranchSelect.value) {
    alert("Please select a parent branch for worktree session");
    return;
  }

  // Validate branch name doesn't already exist for worktree sessions
  if (sessionType === SessionType.WORKTREE && !validateBranchName()) {
    alert("Cannot create worktree: branch already exists");
    return;
  }

  const setupCommandsTextarea = document.getElementById("setup-commands") as HTMLTextAreaElement;
  const setupCommandsText = setupCommandsTextarea?.value.trim();
  const setupCommands = setupCommandsText
    ? setupCommandsText.split("\n").filter(cmd => cmd.trim())
    : undefined;

  const branchNameInput = document.getElementById("branch-name") as HTMLInputElement;
  const branchName = branchNameInput?.value.trim() || undefined;

  const config: SessionConfig = {
    projectDir: selectedDirectory,
    sessionType,
    parentBranch: sessionType === SessionType.WORKTREE ? parentBranchSelect.value : undefined,
    branchName,
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
  // Only load MCP servers if there's an active session
  if (!activeSessionId) {
    return;
  }

  try {
    await ipcRenderer.invoke("list-mcp-servers", activeSessionId);
    // Results will come via mcp-servers-updated event
  } catch (error) {
    console.error("Failed to load MCP servers:", error);
  }
}

// Force immediate refresh of MCP servers after add/remove operations
async function refreshMcpServers() {
  if (!activeSessionId) {
    return;
  }

  // Show loading state on add button
  const addMcpServerBtn = document.getElementById("add-mcp-server");
  if (addMcpServerBtn) {
    addMcpServerBtn.innerHTML = '<span class="loading-spinner"></span>';
    addMcpServerBtn.classList.add("pointer-events-none");
  }

  try {
    // Trigger MCP list command
    await ipcRenderer.invoke("list-mcp-servers", activeSessionId);
    // Wait a bit for the poller to process and send results
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.error("Failed to refresh MCP servers:", error);
  } finally {
    // Restore add button will happen via mcp-servers-updated event
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
        // Optimistically remove from UI
        mcpServers = mcpServers.filter(s => s.name !== server.name);
        renderMcpServers();

        try {
          await ipcRenderer.invoke("remove-mcp-server", server.name);
        } catch (error) {
          alert(`Failed to remove server: ${error}`);
          // Refresh to restore correct state on error
          await refreshMcpServers();
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
  const originalText = addMcpBtn.innerHTML;
  addMcpBtn.innerHTML = '<span class="loading-spinner"></span> Adding...';
  addMcpBtn.disabled = true;
  addMcpBtn.classList.add("opacity-50", "cursor-not-allowed");

  try {
    await ipcRenderer.invoke("add-mcp-server", name, config);
    mcpModal?.classList.add("hidden");
    // Force immediate refresh of MCP servers
    await refreshMcpServers();
  } catch (error) {
    console.error("Error adding server:", error);
    alert(`Failed to add server: ${error}`);
  } finally {
    // Reset button state
    addMcpBtn.innerHTML = originalText;
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
    // Close modal immediately
    mcpDetailsModal?.classList.add("hidden");

    // Optimistically remove from UI
    mcpServers = mcpServers.filter(s => s.name !== serverName);
    renderMcpServers();

    try {
      await ipcRenderer.invoke("remove-mcp-server", serverName);
    } catch (error) {
      alert(`Failed to remove server: ${error}`);
      // Refresh to restore correct state on error
      await refreshMcpServers();
    }
  }
});

// Listen for MCP polling started event
ipcRenderer.on("mcp-polling-started", (_event, sessionId: string) => {
  if (sessionId === activeSessionId) {
    const addMcpServerBtn = document.getElementById("add-mcp-server");
    if (addMcpServerBtn) {
      addMcpServerBtn.innerHTML = '<span class="loading-spinner"></span>';
      addMcpServerBtn.classList.add("pointer-events-none");
    }
  }
});

// Listen for MCP server updates from main process
ipcRenderer.on("mcp-servers-updated", (_event, sessionId: string, servers: McpServer[]) => {
  // Only update if this is for the active session
  if (sessionId === activeSessionId) {
    mcpServers = servers;
    renderMcpServers();

    // Restore add button
    const addMcpServerBtn = document.getElementById("add-mcp-server");
    if (addMcpServerBtn) {
      addMcpServerBtn.innerHTML = '+';
      addMcpServerBtn.classList.remove("pointer-events-none");
    }
  }
});

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
const settingsWorktreeDir = document.getElementById("settings-worktree-dir") as HTMLInputElement;
const browseWorktreeDirBtn = document.getElementById("browse-worktree-dir");

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
  settingsWorktreeDir.value = terminalSettings.worktreeDir;
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

// Browse worktree directory
browseWorktreeDirBtn?.addEventListener("click", async () => {
  const dir = await ipcRenderer.invoke("select-directory");
  if (dir) {
    settingsWorktreeDir.value = dir;
  }
});

// Save settings
saveSettingsBtn?.addEventListener("click", async () => {
  // Read values from form
  terminalSettings.theme = settingsTheme.value;
  terminalSettings.fontFamily = settingsFontFamily.value || DEFAULT_SETTINGS.fontFamily;
  terminalSettings.fontSize = parseInt(settingsFontSize.value) || DEFAULT_SETTINGS.fontSize;
  terminalSettings.cursorBlink = settingsCursorBlink.checked;
  terminalSettings.worktreeDir = settingsWorktreeDir.value || DEFAULT_SETTINGS.worktreeDir;

  // Save to electron-store
  await ipcRenderer.invoke("save-terminal-settings", terminalSettings);

  // Apply to all existing terminals
  applySettingsToAllTerminals();

  // Close modal
  settingsModal?.classList.add("hidden");
});

// Load settings on startup
loadSettings();

// Close session menus when clicking outside
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest(".session-menu") && !target.classList.contains("session-menu-btn")) {
    document.querySelectorAll(".session-menu").forEach(menu => {
      menu.classList.add("hidden");
    });
  }
});
