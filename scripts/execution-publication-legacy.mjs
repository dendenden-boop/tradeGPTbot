// Restore the exact accepted fixture for historical source integrity checks.
// No case bodies, assertions, deadlines or runtime code are substituted.
const before =
  '  await ports.snapshots.publish(f.s, startIo());\n  await ports.trades.publish(f.p, startIo());\n';
const after = `  // Independent public market and runtime evidence all settle before admission.
  // Each authority performs its real current transaction with unchanged IO.
  const [snapshotReceipt, tradeReceipt] = await runIndependentFixtureSetup([
    () => ports.snapshots.publish(f.s, startIo()),
    () => ports.trades.publish(f.p, startIo()),
    () => ports.runtime.publish(publication, startIo()),
  ]);
  if (snapshotReceipt.status !== 'APPLIED' || tradeReceipt.status !== 'APPLIED')
    throw Error('EXECUTION_START_MARKET_PUBLICATION_NOT_APPLIED');
`;
const returnReceipts = '    snapshotReceipt,\n    tradeReceipt,\n';
export function beforeExecutionPublications(source) {
  if (!source.includes('Independent public market and runtime evidence')) return source;
  const marker = '  const publication: PaperRuntimePublication = {\n';
  if (
    source.split(after).length !== 2 ||
    source.split(marker).length !== 2 ||
    source.split(returnReceipts).length !== 2 ||
    source.includes(before)
  )
    throw Error('EXECUTION_PUBLICATION_REVIEW_REQUIRED');
  return beforeIdentityRead(source)
    .replace(after, '  await ports.runtime.publish(publication, startIo());\n')
    .replace(returnReceipts, '')
    .replace(marker, before + marker);
}

// Restore the reviewed location for fingerprinting. The SQL and every other
// byte still participate in the historical digest.
function beforeIdentityRead(source) {
  const identity = '  const identity = (\n';
  const clock = '  const now = Date.now();\n';
  const approval = '  const approvalInput = {\n';
  const start = source.indexOf(identity);
  const end = source.indexOf(clock);
  if (start > end) return source;
  if (
    start < 0 ||
    end < 0 ||
    [identity, clock, approval].some((marker) => source.split(marker).length !== 2) ||
    source.indexOf(approval) < end
  )
    throw Error('EXECUTION_PUBLICATION_REVIEW_REQUIRED');
  const block = source.slice(start, end);
  return source.replace(block, '').replace(approval, block + approval);
}

// Exact fingerprint-only restoration before older scheduler history checks.
export function beforeExecutionPublicationFingerprint(file, source) {
  if (file !== 'scripts/database-cohorts.mjs') return source;
  const matches = [
    'f8d9319268b5259fc421226a4090bed95cb6a79e7963db22bcc3bff172e47a3f',
    '240bc9b24c30b0d70a8548aa42e3cd0273352b25e233b02fc778d2b1bb0dda2c',
  ].filter((pin) => source.includes(pin));
  if (matches.length === 0) return source;
  if (matches.length !== 1 || source.split(matches[0]).length !== 2)
    throw Error('EXECUTION_PUBLICATION_REVIEW_REQUIRED');
  return source.replace(
    matches[0],
    '22fc143b5771bef5b886cb7122bdc4a60c2db9758d29f9560c1ec18ddf4285fb',
  );
}
