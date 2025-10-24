export enum SessionType {
  WORKTREE = "worktree",
  LOCAL = "local"
}

export interface SessionConfig {
  projectDir: string;
  sessionType: SessionType;
  parentBranch?: string;
  branchName?: string;
  codingAgent: string;
  skipPermissions: boolean;
  setupCommands?: string[];
}

export interface PersistedSession {
  id: string;
  number: number;
  name: string;
  config: SessionConfig;
  worktreePath?: string;
  createdAt: number;
  sessionUuid: string;
  mcpConfigPath?: string;
  gitBranch?: string;
}
