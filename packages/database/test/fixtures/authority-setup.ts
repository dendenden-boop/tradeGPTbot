// Isolated test setup only: both operations still execute and physically settle.
// Retains no data, constructor, receipt or admission result between invocations.
export async function settleAuthorityFixturePair<A, B>(
  lanes: readonly [() => Promise<A>, () => Promise<B>],
): Promise<[A, B]> {
  if (
    !Array.isArray(lanes) ||
    lanes.length !== 2 ||
    [0, 1].some((index) => typeof lanes[index] !== 'function')
  )
    throw Error('AUTHORITY_FIXTURE_LANES');
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(lanes[0]),
    Promise.resolve().then(lanes[1]),
  ]);
  if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
  if (outcomes[1].status === 'rejected') throw outcomes[1].reason;
  return [outcomes[0].value, outcomes[1].value];
}
