// `npm test`: runs the test suite with a private temporary directory and fails when it leaves any t3fg-* directory behind.
// Usage: node scripts/test-run.ts [node --test arguments]   (default: every test/**/*.test.ts)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const testArgs = args.length > 0 ? args : ['--test-reporter=spec', 'test/**/*.test.ts'];

// The suite's own temporary directories land here (TMPDIR on POSIX, TEMP/TMP on Windows), so a leak is counted exactly
// and a failed run never fills the shared temporary directory.
const sandbox = mkdtempSync(join(tmpdir(), 'tfg-testrun-'));
const env = { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox };
const run = spawnSync(process.execPath, ['--test', '--test-timeout=30000', ...testArgs], { cwd: root, env, stdio: 'inherit' });

const leaked = readdirSync(sandbox).filter((name) => name.startsWith('t3fg-'));
process.stderr.write(`\ntemp check: ${leaked.length} t3fg-* director${leaked.length === 1 ? 'y' : 'ies'} left behind after the run\n`);
if (leaked.length > 0) {
  const kinds = new Map<string, number>();
  for (const name of leaked) {
    const kind = name.replace(/-[A-Za-z0-9]{6}$/, '');
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  for (const [kind, count] of kinds) process.stderr.write(`  ${kind}-*: ${count}\n`);
}
rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
if (leaked.length > 0 && process.exitCode === 0) process.exitCode = 1;
