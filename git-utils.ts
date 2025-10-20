import {simpleGit, SimpleGit} from "simple-git";

/**
 * Sort branches with main/master appearing first
 */
export function sortBranchesWithMainFirst(branches: string[]): string[] {
  return branches.sort((a, b) => {
    const aIsMainOrMaster = a === 'main' || a === 'master';
    const bIsMainOrMaster = b === 'main' || b === 'master';

    if (aIsMainOrMaster && !bIsMainOrMaster) return -1;
    if (!aIsMainOrMaster && bIsMainOrMaster) return 1;

    return 0;
  });
}

/**
 * Get git branches from a directory, sorted with main/master first
 */
export async function getBranches(dirPath: string): Promise<string[]> {
  try {
    const git = simpleGit(dirPath);
    const branchSummary = await git.branch();
    const branches = branchSummary.all;
    return sortBranchesWithMainFirst(branches);
  } catch (error) {
    console.error("Error getting branches:", error);
    return [];
  }
}
