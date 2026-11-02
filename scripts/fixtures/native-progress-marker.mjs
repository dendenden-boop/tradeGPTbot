import { access } from 'node:fs/promises';

// Test-only readiness boundary, initially retaining the existing existence check.
export async function isNativeProgressMarkerReady(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}
