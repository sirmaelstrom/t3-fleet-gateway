import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GatewayError } from './errors.ts';

export const DATABASE_FILE = 'gateway.db';
export const KEY_FILE = 'gateway.key';
const KEY_BYTES = 32;

export interface DataDir {
  path: string;
  databasePath: string;
  /** Server secret for HMACs (approval form integrity, approval-code hashing). */
  key: Buffer;
}

function assertPrivate(path: string, kind: 'directory' | 'file'): void {
  const stats = statSync(path);
  if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
    throw new GatewayError('data_dir_insecure', `${path} is not a ${kind}`);
  }
  // Windows has no POSIX mode bits (Node reports 666 for every file); the directory's access list is what keeps it
  // private. Remove inheritance and grant only the owner: icacls <dir> /inheritance:r /grant:r <user>:(OI)(CI)F
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new GatewayError('data_dir_insecure', `${path} is owned by another user`);
  }
  if ((stats.mode & 0o077) !== 0) {
    const fix = kind === 'directory' ? 'chmod 700' : 'chmod 600';
    throw new GatewayError(
      'data_dir_insecure',
      `${path} is accessible to group or others (mode ${(stats.mode & 0o777).toString(8)}). Fix with: ${fix} '${path}'`,
    );
  }
}

/** Check permissions of the data directory and every file the gateway keeps in it. */
export function checkDataDirPermissions(path: string): void {
  assertPrivate(path, 'directory');
  for (const name of [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, KEY_FILE]) {
    const file = join(path, name);
    if (existsSync(file)) assertPrivate(file, 'file');
  }
}

function readOrCreateKey(path: string): Buffer {
  const keyPath = join(path, KEY_FILE);
  if (!existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(KEY_BYTES), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      // Another process (CLI and server share the directory) may have created it first.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  assertPrivate(keyPath, 'file');
  const key = readFileSync(keyPath);
  if (key.length !== KEY_BYTES) {
    throw new GatewayError('data_dir_insecure', `${keyPath} is corrupt (expected ${KEY_BYTES} bytes)`);
  }
  return key;
}

/**
 * Create the data directory if needed (mode 0700), refuse to continue when it or its files are
 * readable by others, and load the server key. Sets a restrictive umask so files SQLite creates
 * later (WAL, shared memory) are private too.
 */
export function openDataDir(path: string): DataDir {
  process.umask(0o077);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  checkDataDirPermissions(path);
  const key = readOrCreateKey(path);
  return { path, databasePath: join(path, DATABASE_FILE), key };
}
