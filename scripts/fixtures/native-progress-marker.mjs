import { readFile } from 'node:fs/promises';

// Test-only acknowledgement after actual VerboseReporter stdout delivery. An
// existing file may still be empty/partial while writeFile is in progress.
// Waiting for the original timestamp does not synthesize or renew evidence.
export async function isNativeProgressMarkerReady(file, bounds) {
  if (
    bounds === null ||
    typeof bounds !== 'object' ||
    Object.keys(bounds).sort().join(',') !== 'notAfter,notBefore' ||
    !Number.isSafeInteger(bounds.notBefore) ||
    !Number.isSafeInteger(bounds.notAfter) ||
    bounds.notBefore <= 0 ||
    bounds.notAfter < bounds.notBefore
  )
    throw Error('NATIVE_PROGRESS_MARKER_WINDOW');
  let wire;
  try {
    wire = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const timestamp = Number(wire);
  return (
    Number.isSafeInteger(timestamp) &&
    String(timestamp) === wire &&
    timestamp >= bounds.notBefore &&
    timestamp <= bounds.notAfter
  );
}
