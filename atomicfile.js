// Save a file so a crash never leaves it half-written: write a temp file, then rename it over the old one.
// Each save gets its own temp name, so two saves of the same file at once can't take each other's temp file
// (with one shared `.tmp`, the second rename failed with ENOENT). On Windows a rename can briefly fail while
// antivirus or the search indexer holds the file, so it's retried for about a second.
import { rename, unlink, writeFile } from 'node:fs/promises';

let seq = 0;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function writeAtomic(file, data, { tries = 6, wait = (ms) => new Promise((r) => setTimeout(r, ms)), renameImpl = rename } = {}) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  await writeFile(tmp, data);
  for (let i = 1; ; i++) {
    try {
      return await renameImpl(tmp, file);
    } catch (e) {
      if (!BUSY.has(e.code) || i >= tries) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await wait(50 * 2 ** (i - 1)); // 50, 100, 200, 400, 800 ms
    }
  }
}
