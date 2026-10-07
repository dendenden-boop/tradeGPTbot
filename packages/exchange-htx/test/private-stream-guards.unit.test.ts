import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
import { now, account, linearOrder } from './fixtures.js';
import { until } from './fixtures/io.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
describe('HTX private position observation races', () => {
  it('rechecks metadata after asynchronous permission resolution before publishing a position', async () => {
    const x = harness('htx-linear-live-v1');
    adapters.push(x.adapter);
    const r = await x.warm();
    const result = await x.adapter.subscribePositions({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    x.permissions.verify.mockImplementation(async () => {
      await x.options.registry.put(
        {
          ...r,
          instrument: { ...r.instrument, metadataVersion: 'next-meta' },
          rules: { ...r.rules, version: 'next-rules' },
        },
        now,
      );
      return Promise.resolve({
        profileId: 'htx-linear-live-v1',
        account,
        credentialRef: 'fixture-reference',
        accountMode: 'SINGLE_ASSET_CROSS_HEDGE',
        canRead: true,
        canTrade: true,
        withdrawalEnabled: false,
        checkedAt: now,
        expiresAt: now + 30000,
      });
    });
    x.emit({
      op: 'notify',
      topic: `positions_cross.${x.symbol}`,
      uid: account.externalAccountId,
      ts: now,
      data: [
        {
          ...linearOrder,
          position_mode: 'dual_side',
          cost_open: '50000',
          lever_rate: '5',
          profit: '0',
          profit_unreal: '1',
        },
      ],
    });
    await until(
      () => result.value.health().queued > 0 || result.value.health().status !== 'ACTIVE',
    );
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
    expect(result.value.health().queued).toBe(0);
  });
  it('regressed position timestamp is a gap, not an overwrite of newer state', async () => {
    const x = harness('htx-linear-live-v1');
    adapters.push(x.adapter);
    await x.warm();
    const result = await x.adapter.subscribePositions({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    const frame = {
      op: 'notify',
      topic: `positions_cross.${x.symbol}`,
      uid: account.externalAccountId,
      ts: now,
      data: [
        {
          ...linearOrder,
          position_mode: 'dual_side',
          cost_open: '50000',
          lever_rate: '5',
          profit: '0',
          profit_unreal: '1',
        },
      ],
    };
    x.emit(frame);
    await until(() => result.value.health().queued === 1);
    x.emit({ ...frame, ts: now - 1 });
    await until(
      () => result.value.health().queued > 1 || result.value.health().status !== 'ACTIVE',
    );
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
  });
});
