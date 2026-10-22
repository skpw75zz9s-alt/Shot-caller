import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../atomicfile.js';

test('many saves of the same file at once all succeed, and leave no temp files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-')), file = join(dir, 'record.json');
  await Promise.all(Array.from({ length: 25 }, (_, i) => writeAtomic(file, JSON.stringify({ i }))));
  assert.ok(Number.isInteger(JSON.parse(readFileSync(file, 'utf8')).i));
  assert.deepEqual(readdirSync(dir), ['record.json']);
});

test('a rename held up for a moment (Windows antivirus) is retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-')), file = join(dir, 'a.json');
  let calls = 0;
  const { rename } = await import('node:fs/promises');
  const flaky = async (a, b) => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return rename(a, b); };
  await writeAtomic(file, '{"ok":true}', { renameImpl: flaky, wait: async () => {} });
  assert.equal(calls, 3);
  assert.equal(readFileSync(file, 'utf8'), '{"ok":true}');
});

test('another failure is thrown at once, and its temp file is removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-')), file = join(dir, 'b.json');
  let calls = 0;
  const broken = async () => { calls++; throw Object.assign(new Error('nope'), { code: 'EXDEV' }); };
  await assert.rejects(writeAtomic(file, '{}', { renameImpl: broken, wait: async () => {} }), /nope/);
  assert.equal(calls, 1);
  assert.deepEqual(readdirSync(dir), []);
});
