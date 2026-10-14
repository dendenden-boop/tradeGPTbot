import { expect, it } from 'vitest';
import * as server from '../src/portfolio.js';

it('has a server-owned atomic PAPER order-risk source, separate from the pure calculator', () => {
  const factory = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperOrderRiskSource'
  ];
  expect(typeof factory, 'PAPER_ORDER_RISK_FACTORY_MISSING').toBe('function');
});
