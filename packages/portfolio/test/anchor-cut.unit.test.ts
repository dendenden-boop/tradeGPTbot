import { expect, it } from 'vitest';
import { createState, reducePortfolio } from '../src/accounting.js';
import { binding, snapshot, fill, context } from './fixtures.js';
it.each([999, 1000])(
  'does not add an unseen execution at or before the inclusive snapshot cut %i',
  (timestamp) => {
    const s = reducePortfolio(createState(binding()), snapshot({ timestamp: 1000 }), context).state;
    expect(() => reducePortfolio(s, fill({ timestamp }), context)).toThrow('OUT_OF_ORDER_ECONOMIC');
  },
);
