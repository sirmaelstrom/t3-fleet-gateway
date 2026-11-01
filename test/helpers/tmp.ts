import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { TestContext } from 'node:test';

const created = new Set<string>();

const remove = (dir: string, retries: number) => rmSync(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: 50 });

// Windows cannot delete a file a process still holds open. A test's own `t.after` hooks run in the order they were
// registered, so a database opened after `tempDir(t)` is still open when this directory's hook runs and the delete
// fails with EPERM/EBUSY. Each test therefore tries once without failing, and this file-level hook (it runs after every
// test of the file has finished and closed its handles) removes what is left, retrying busy files.
after(() => {
  for (const dir of created) {
    remove(dir, 20);
    created.delete(dir);
  }
});

/** A private temporary directory removed when the test (or, if its files are still open then, the test file) finishes. */
export function tempDir(t: TestContext, prefix = 't3fg-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  t.after(() => {
    try {
      remove(dir, 0);
      created.delete(dir);
    } catch {
      // Still in use; the file-level hook removes it.
    }
  });
  return dir;
}
