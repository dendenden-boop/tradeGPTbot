import { setTimeout as delay } from 'node:timers/promises';

interface Clock {
  now(): number;
  monotonic(): number;
  pause(ms: number, signal: AbortSignal): Promise<void>;
}
const actual: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  pause: async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
};

// Test-only wait for genuine post-latency observations. Timer completion alone
// does not certify wall-clock eligibility. Never manufacture a future timestamp.
export async function waitForFixtureClock(
  eligible: number,
  io: { signal: AbortSignal; deadline: number },
  clock: Clock = actual,
): Promise<number> {
  if (!Number.isSafeInteger(eligible) || eligible < 0 || !Number.isSafeInteger(io.deadline))
    throw Error('PREVIEW_FIXTURE_INPUT');
  const start = clock.now(),
    monotonicStart = clock.monotonic();
  const budget = Math.min(2500, io.deadline - start);
  if (!Number.isSafeInteger(start) || !Number.isFinite(monotonicStart))
    throw Error('PREVIEW_FIXTURE_CLOCK');
  if (budget <= 0 || eligible >= io.deadline || eligible - start >= budget)
    throw Error('PREVIEW_FIXTURE_DEADLINE');
  let previous = start;
  for (let attempt = 0; attempt < 64; attempt++) {
    if (io.signal.aborted) throw Error('PREVIEW_FIXTURE_ABORTED');
    const now = clock.now(),
      elapsed = clock.monotonic() - monotonicStart;
    if (!Number.isSafeInteger(now) || now < previous || !Number.isFinite(elapsed) || elapsed < 0)
      throw Error('PREVIEW_FIXTURE_CLOCK');
    if (now >= io.deadline || elapsed >= budget) throw Error('PREVIEW_FIXTURE_DEADLINE');
    if (now >= eligible) return now;
    previous = now;
    try {
      await clock.pause(
        Math.max(1, Math.min(eligible - now, io.deadline - now, budget - elapsed)),
        io.signal,
      );
    } catch (error) {
      if (io.signal.aborted) throw Error('PREVIEW_FIXTURE_ABORTED', { cause: error });
      throw error;
    }
  }
  throw Error('PREVIEW_FIXTURE_BOUNDARY');
}
