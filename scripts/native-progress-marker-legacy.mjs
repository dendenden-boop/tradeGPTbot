// Test-only reconstruction of the five accepted native progress scenarios.
export function beforeNativeProgressMarker(source) {
  const blocks = [
    [
      "// NATIVE PROGRESS MARKER IMPORT BEGIN\nimport { isNativeProgressMarkerReady } from './fixtures/native-progress-marker.mjs';\n// NATIVE PROGRESS MARKER IMPORT END\n",
      '',
    ],
    [
      "    // NATIVE PROGRESS MARKER WAIT BEGIN\n    const progressStartedAt = Number(await readFile(path.join(dir, 'start.at'), 'utf8'));\n    while (\n      !(await isNativeProgressMarkerReady(path.join(dir, 'progress.ready'), {\n        notBefore: progressStartedAt,\n        notAfter: Date.now(),\n      }))\n    ) {\n      // NATIVE PROGRESS MARKER WAIT END\n",
      "    while (!(await exists(path.join(dir, 'progress.ready')))) {\n",
    ],
  ];
  for (const [block, original] of blocks) {
    if (source.split(block).length !== 2) throw Error('NATIVE_PROGRESS_MARKER_REVIEW_REQUIRED');
    source = source.replace(block, original);
  }
  if (source.includes('NATIVE PROGRESS MARKER'))
    throw Error('NATIVE_PROGRESS_MARKER_REVIEW_REQUIRED');
  return source;
}
