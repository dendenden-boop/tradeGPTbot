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
