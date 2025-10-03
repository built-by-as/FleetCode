import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: "stdio" | "sse";
}

export class SimpleClaude {
  private claudePath: string;

  constructor(claudePath: string = "claude") {
    this.claudePath = claudePath;
  }

  async listMcpServers(): Promise<McpServer[]> {
    try {
      const { stdout } = await execAsync(`${this.claudePath} mcp list`);

      // If no servers configured, return empty array
      if (stdout.includes("No MCP servers configured")) {
        return [];
      }

      // Parse the output - format is typically a list of server names
      // We'll need to get details for each server
      const lines = stdout.trim().split("\n").filter(line => line.trim());
      const servers: McpServer[] = [];

      for (const line of lines) {
        // Skip header lines
        if (line.includes("MCP servers") || line.includes("---")) {
          continue;
        }

        const serverName = line.trim();
        if (serverName) {
          try {
            const details = await this.getMcpServer(serverName);
            servers.push(details);
          } catch (error) {
            // If we can't get details, just add the name
            servers.push({ name: serverName });
          }
        }
      }

      return servers;
    } catch (error) {
      console.error("Error listing MCP servers:", error);
      return [];
    }
  }

  async getMcpServer(name: string): Promise<McpServer> {
    try {
      const { stdout } = await execAsync(`${this.claudePath} mcp get "${name}"`);

      // Try to parse as JSON if possible
      try {
        const parsed = JSON.parse(stdout);
        return { name, ...parsed };
      } catch {
        // If not JSON, return basic info
        return { name };
      }
    } catch (error) {
      throw new Error(`Failed to get MCP server ${name}: ${error}`);
    }
  }

  async addMcpServer(name: string, command: string, args: string[] = []): Promise<void> {
    try {
      const argsStr = args.join(" ");
      await execAsync(`${this.claudePath} mcp add "${name}" ${command} ${argsStr}`);
    } catch (error) {
      throw new Error(`Failed to add MCP server ${name}: ${error}`);
    }
  }

  async removeMcpServer(name: string): Promise<void> {
    try {
      await execAsync(`${this.claudePath} mcp remove "${name}"`);
    } catch (error) {
      throw new Error(`Failed to remove MCP server ${name}: ${error}`);
    }
  }
}

export function simpleClaude(claudePath?: string): SimpleClaude {
  return new SimpleClaude(claudePath);
}
