import {getBranches, sortBranchesWithMainFirst} from './git-utils';
import {simpleGit} from 'simple-git';

// Mock simple-git
jest.mock('simple-git');

describe('sortBranchesWithMainFirst', () => {
  it('should place main branch first', () => {
    const branches = ['feature/test', 'develop', 'main', 'bugfix/issue'];
    const sorted = sortBranchesWithMainFirst(branches);
    expect(sorted[0]).toBe('main');
  });

  it('should place master branch first', () => {
    const branches = ['feature/test', 'develop', 'master', 'bugfix/issue'];
    const sorted = sortBranchesWithMainFirst(branches);
    expect(sorted[0]).toBe('master');
  });

  it('should place both main and master at the top', () => {
    const branches = ['feature/test', 'master', 'main', 'develop'];
    const sorted = sortBranchesWithMainFirst(branches);
    expect(['main', 'master']).toContain(sorted[0]);
    expect(['main', 'master']).toContain(sorted[1]);
  });

  it('should handle branches with main as substring', () => {
    const branches = ['feature/main-feature', 'main', 'main-branch'];
    const sorted = sortBranchesWithMainFirst(branches);
    expect(sorted[0]).toBe('main');
    expect(sorted).toContain('feature/main-feature');
    expect(sorted).toContain('main-branch');
  });

  it('should preserve order of non-main/master branches', () => {
    const branches = ['feature/a', 'feature/b', 'feature/c'];
    const sorted = sortBranchesWithMainFirst([...branches]);
    expect(sorted).toEqual(branches);
  });

  it('should handle empty array', () => {
    const sorted = sortBranchesWithMainFirst([]);
    expect(sorted).toEqual([]);
  });

  it('should handle array with only main', () => {
    const sorted = sortBranchesWithMainFirst(['main']);
    expect(sorted).toEqual(['main']);
  });

  it('should handle array with only master', () => {
    const sorted = sortBranchesWithMainFirst(['master']);
    expect(sorted).toEqual(['master']);
  });
});

describe('getBranches', () => {
  const mockGit = {
    branch: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (simpleGit as jest.Mock).mockReturnValue(mockGit);
  });

  it('should fetch and sort branches with main first', async () => {
    mockGit.branch.mockResolvedValue({
      all: ['feature/test', 'develop', 'main', 'bugfix/issue'],
      branches: {},
      current: 'main',
      detached: false,
    });

    const branches = await getBranches('/test/path');

    expect(simpleGit).toHaveBeenCalledWith('/test/path');
    expect(mockGit.branch).toHaveBeenCalled();
    expect(branches[0]).toBe('main');
    expect(branches).toHaveLength(4);
  });

  it('should fetch and sort branches with master first', async () => {
    mockGit.branch.mockResolvedValue({
      all: ['feature/test', 'master', 'develop'],
      branches: {},
      current: 'master',
      detached: false,
    });

    const branches = await getBranches('/test/path');

    expect(branches[0]).toBe('master');
    expect(branches).toHaveLength(3);
  });

  it('should handle errors and return empty array', async () => {
    mockGit.branch.mockRejectedValue(new Error('Git error'));

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    const branches = await getBranches('/test/path');

    expect(branches).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Error getting branches:',
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  it('should handle empty branch list', async () => {
    mockGit.branch.mockResolvedValue({
      all: [],
      branches: {},
      current: '',
      detached: false,
    });

    const branches = await getBranches('/test/path');

    expect(branches).toEqual([]);
  });

  it('should sort both main and master to the top', async () => {
    mockGit.branch.mockResolvedValue({
      all: ['feature/a', 'master', 'feature/b', 'main', 'develop'],
      branches: {},
      current: 'main',
      detached: false,
    });

    const branches = await getBranches('/test/path');

    expect(['main', 'master']).toContain(branches[0]);
    expect(['main', 'master']).toContain(branches[1]);
  });
});
