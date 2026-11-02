import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isNativeProgressMarkerReady } from './fixtures/native-progress-marker.mjs';
import { beforeNativeProgressMarker } from './native-progress-marker-legacy.mjs';

const root = fileURLToPath(new URL('../test-results/cohort-unit/', import.meta.url));
const bounds = { notBefore: 1_793_601_615_541, notAfter: 1_793_601_623_541 };
const timestamp = bounds.notBefore + 6200;
async function marker() {
  await mkdir(root, { recursive: true });
  return path.join(await mkdtemp(path.join(root, 'marker-contract-')), 'progress.ready');
}

it('does not accept a visible empty acknowledgement before its actual write completes', async () => {
  const file = await marker(),
    handle = await open(file, 'w');
  try {
    // The real file is now visible, exactly as in the failed PR artifact. The
    // writer stays open; no scheduler delay or sleep creates this interleaving.
    expect(await readFile(file, 'utf8')).toBe('');
    expect(await isNativeProgressMarkerReady(file, bounds)).toBe(false);
    await handle.writeFile(String(timestamp));
    expect(await isNativeProgressMarkerReady(file, bounds)).toBe(true);
  } finally {
    await handle.close();
  }
});

it('rejects partial, malformed and out-of-window marker content without inventing a timestamp', async () => {
  const file = await marker();
  for (const value of [
    String(timestamp).slice(0, -1),
    'NaN',
    'Infinity',
    '1.5',
    ' ' + timestamp,
    timestamp + '\n',
    String(bounds.notBefore - 1),
    String(bounds.notAfter + 1),
    '9007199254740992',
  ]) {
    await writeFile(file, value);
    expect(await isNativeProgressMarkerReady(file, bounds), value).toBe(false);
  }
});

it('accepts a complete current acknowledgement and preserves its actual timestamp', async () => {
  const file = await marker();
  for (const value of [bounds.notBefore, timestamp, bounds.notAfter]) {
    await writeFile(file, String(value));
    expect(await isNativeProgressMarkerReady(file, bounds)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(String(value));
  }
});

it('keeps a missing acknowledgement unready without creating a file', async () => {
  const file = await marker();
  expect(await isNativeProgressMarkerReady(file, bounds)).toBe(false);
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('surfaces actual filesystem read errors instead of treating existence as readiness', async () => {
  const file = await marker();
  await mkdir(file);
  await expect(isNativeProgressMarkerReady(file, bounds)).rejects.toMatchObject({ code: 'EISDIR' });
});

it('requires a strict positive finite timestamp window before reading a marker', async () => {
  const file = await marker();
  await writeFile(file, String(timestamp));
  for (const window of [
    { notBefore: 0, notAfter: timestamp },
    { notBefore: NaN, notAfter: timestamp },
    { notBefore: timestamp, notAfter: Infinity },
    { notBefore: timestamp + 1, notAfter: timestamp },
    { ...bounds, invented: true },
  ]) {
    await expect(isNativeProgressMarkerReady(file, window)).rejects.toThrow(
      'NATIVE_PROGRESS_MARKER_WINDOW',
    );
  }
});

it('preserves all five prior physical progress scenarios, assertions and original deadlines', async () => {
  const source = (
    await readFile(new URL('./native-progress.unit.test.mjs', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const original = beforeNativeProgressMarker(source);
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    '7e40d877c0d3b61e5b9b39f6efeb4409bb5b900d57e9b44d8660edf56f84498e',
  );
  for (const mutation of [
    source.replace('// NATIVE PROGRESS MARKER WAIT BEGIN', '// changed'),
    source + '\n// NATIVE PROGRESS MARKER WAIT BEGIN\n',
    source.replace('notAfter: Date.now(),', 'notAfter: Date.now() + 1000,'),
  ]) {
    expect(() => beforeNativeProgressMarker(mutation)).toThrow(
      'NATIVE_PROGRESS_MARKER_REVIEW_REQUIRED',
    );
  }
});
