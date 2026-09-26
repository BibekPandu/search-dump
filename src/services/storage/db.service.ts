import { LibSQLStore } from '@mastra/libsql';
import fs from 'fs';
import path from 'path';

export function getProjectRootDir(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
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
