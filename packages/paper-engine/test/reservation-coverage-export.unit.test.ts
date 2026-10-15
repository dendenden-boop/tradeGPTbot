import { expect, it } from 'vitest';
import * as paper from '../src/index.js';

it('exposes a pure multi-asset coverage calculation before PAPER financial admission', () => {
  expect(
    (paper as unknown as Record<string, unknown>)['calculatePaperReservationCoverage'],
    'PAPER_RESERVATION_COVERAGE_MISSING',
  ).toBeTypeOf('function');
});
