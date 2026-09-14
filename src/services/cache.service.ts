import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getProjectRootDir } from './db.service';

const CACHE_DIR = path.join(getProjectRootDir(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'search-results.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

let writePending = false;
let pendingCache: Record<string, CacheEntry> | null = null;

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function readCache(): Record<string, CacheEntry> {
  ensureCacheDir();
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CacheEntry>): void {
  if (writePending) {
    pendingCache = cache;
    return;
  }
  writePending = true;
  try {
    ensureCacheDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } finally {
    writePending = false;
    if (pendingCache) {
      const next = pendingCache;
      pendingCache = null;
      writeCache(next);
    }
  }
}

function hashKey(query: string, provider: string): string {
  return crypto.createHash('sha256').update(`${provider}::${query}`).digest('hex').slice(0, 16);
}

export function getCached<T>(query: string, provider: string): T | null {
  const cache = readCache();
  const key = hashKey(query, provider);
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    delete cache[key];
    writeCache(cache);
    return null;
  }
  return entry.data as T;
}

export function setCache(query: string, provider: string, data: unknown): void {
  const cache = readCache();
  const key = hashKey(query, provider);
  cache[key] = { data, timestamp: Date.now() };
  writeCache(cache);
}


