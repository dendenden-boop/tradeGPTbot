import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ path: '', grow: false, reads: 0 }));
vi.mock('node:child_process', () => ({
  execFileSync: (_git, args) =>
    args.includes('-s')
      ? '100644 0000000000000000000000000000000000000000 0\tfile.ts\0'
      : 'file.ts\0',
}));
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return {
    ...fs,
    lstatSync(path) {
      const info = fs.lstatSync(path);
      if (path === state.path && state.grow) {
        state.grow = false;
        fs.writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1));
      }
      return info;
    },
    readSync(path, ...args) {
      state.reads++;
      return fs.readSync(path, ...args);
    },
  };
});
it('reads a stable regular file through the owned bounded descriptor', () => {
  directory = mkdtempSync(join(tmpdir(), 'ctp-secret-read-'));
  state.path = join(directory, 'file.ts');
  writeFileSync(state.path, 'safe');
  expect(scanRepository(directory, 'fixture-git')).toMatchObject({
    status: 'PASS',
    files: 1,
    findings: [],
  });
  expect(state.reads).toBeGreaterThan(0);
});
import { scanRepository } from './scan-secrets.mjs';
let directory;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  state.path = '';
  state.grow = false;
  state.reads = 0;
});
it('rejects a file grown after path inspection without reading its bytes', () => {
  directory = mkdtempSync(join(tmpdir(), 'ctp-secret-read-'));
  state.path = join(directory, 'file.ts');
  writeFileSync(state.path, 'safe');
  state.grow = true;
  expect(() => scanRepository(directory, 'fixture-git')).toThrow('SECRET_SCAN_FILE_CAPACITY');
  expect(state.reads).toBe(0);
});
