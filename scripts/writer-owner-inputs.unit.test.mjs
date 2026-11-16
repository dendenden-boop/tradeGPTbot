import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { verifyWriterOwnerInputs } from './writer-owner-partitions.mjs';
import { writerOwnerInputs, writerOwnerInputHash } from './writer-owner-inputs.mjs';
it('pins the complete executable test-side import closure and both actual native configuration files', async () => {
  const root = process.cwd(),
    queue = [
      'packages/database/test/paper-execution-commit.integration.test.ts',
      'vitest.database.config.ts',
      'vitest.shared.ts',
    ],
    seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const entry of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      if (!entry.fileName.startsWith('.')) continue;
      const relative = path
        .relative(root, path.resolve(path.dirname(file), entry.fileName))
        .split(path.sep)
        .join('/');
      if (relative.includes('/src/') || relative.includes('/dist/')) continue;
      const next = [
        relative,
        relative.replace(/\.js$/u, '.ts'),
        relative.replace(/\.js$/u, '.mjs'),
      ].find((file) => {
        try {
          return readFileSync(file).length >= 0;
        } catch {
          return false;
        }
      });
      expect(next).toBeDefined();
      queue.push(next);
    }
  }
  expect([...seen].sort()).toEqual(Object.keys(writerOwnerInputs).sort());
  expect(await verifyWriterOwnerInputs()).toBe(writerOwnerInputHash);
});
it('rejects an edit to any reviewed input and accepts only equivalent LF/CRLF checkouts', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ctp-writer-inputs-'));
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('ctp-writer-inputs-')
  )
    throw Error('TEST_CLEANUP_SCOPE');
  try {
    for (const file of Object.keys(writerOwnerInputs)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.copyFile(file, path.join(root, file));
    }
    expect(await verifyWriterOwnerInputs(root)).toBe(writerOwnerInputHash);
    for (const file of Object.keys(writerOwnerInputs)) {
      const absolute = path.join(root, file),
        before = await fs.readFile(absolute, 'utf8');
      await fs.writeFile(absolute, before + '\n// unreviewed input\n');
      await expect(verifyWriterOwnerInputs(root)).rejects.toThrow(
        'WRITER_OWNER_INPUT_REVIEW_REQUIRED',
      );
      await fs.writeFile(absolute, before.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    }
    expect(await verifyWriterOwnerInputs(root)).toBe(writerOwnerInputHash);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
