// Restore the exact accepted fixture for historical source integrity checks.
// No case bodies, assertions, deadlines or runtime code are substituted.
const before =
  '  await ports.snapshots.publish(f.s, startIo());\n  await ports.trades.publish(f.p, startIo());\n';
const after = `  // Independent public market and runtime evidence all settle before admission.
  // Each authority performs its real current transaction with unchanged IO.
  await runIndependentFixtureSetup([
    () => ports.snapshots.publish(f.s, startIo()),
    () => ports.trades.publish(f.p, startIo()),
    () => ports.runtime.publish(publication, startIo()),
  ]);
`;
export function beforeExecutionPublications(source) {
  if (!source.includes('Independent public market and runtime evidence')) return source;
  const marker = '  const publication: PaperRuntimePublication = {\n';
  if (
    source.split(after).length !== 2 ||
    source.split(marker).length !== 2 ||
    source.includes(before)
  )
    throw Error('EXECUTION_PUBLICATION_REVIEW_REQUIRED');
  return source
    .replace(after, '  await ports.runtime.publish(publication, startIo());\n')
    .replace(marker, before + marker);
}

// Exact fingerprint-only restoration before older scheduler history checks.
export function beforeExecutionPublicationFingerprint(file, source) {
  if (file !== 'scripts/database-cohorts.mjs') return source;
  const current = 'f8d9319268b5259fc421226a4090bed95cb6a79e7963db22bcc3bff172e47a3f';
  if (!source.includes(current)) return source;
  if (source.split(current).length !== 2) throw Error('EXECUTION_PUBLICATION_REVIEW_REQUIRED');
  return source.replace(
    current,
    '22fc143b5771bef5b886cb7122bdc4a60c2db9758d29f9560c1ec18ddf4285fb',
  );
}
