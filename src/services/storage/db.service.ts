import { LibSQLStore } from '@mastra/libsql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Resolve the project root (the directory holding package.json).
 *
 * Resolution order:
 *   1. Walk up from `process.cwd()`.
 *   2. If that fails — the process was started from outside the repository,
 *      which is the case for any tool that spawns a child with a different
 *      working directory — walk up from this module's own location.
 *   3. Only if both fail, fall back to `process.cwd()`.
 *
 * The second step is what makes path resolution independent of the working
 * directory. Before it, a run started from another directory resolved
 * `.cache/` against that other directory and wrote its geocoding cache next
 * to the process, which is how `src/mastra/public/.cache/geocoding/` came to
 * contain a stray `kathmandu.json`.
 */
export function getProjectRootDir(): string {
  const isProjectRoot = (dir: string): boolean => fs.existsSync(path.join(dir, 'package.json'));

  const walkUp = (startDir: string): string | null => {
    let dir = startDir;
    while (dir !== path.dirname(dir)) {
      if (isProjectRoot(dir)) return dir;
      dir = path.dirname(dir);
    }
    return isProjectRoot(dir) ? dir : null;
  };

  const fromCwd = walkUp(process.cwd());
  if (fromCwd) return fromCwd;

  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const fromModule = walkUp(moduleDir);
    if (fromModule) return fromModule;
  } catch {
    // import.meta.url unavailable (non-ESM context) — fall through.
  }

  return process.cwd();
}

function getDatabaseUrl(): string {
  const root = getProjectRootDir();
  const dbPath = path.join(root, 'mastra.db').replace(/\\/g, '/');
  return `file:${dbPath}`;
}

export function createMemoryStorage(id: string): LibSQLStore {
  return new LibSQLStore({
    id,
    url: getDatabaseUrl(),
  });
}
