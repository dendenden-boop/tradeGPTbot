import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
import { now } from './fixtures.js';
import { htxProfileIds, type HtxProfileId } from '../src/profiles.js';

const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.disconnect();
});
async function book(profile: HtxProfileId, depth = 20) {
  const x = harness(profile);
  adapters.push(x.adapter);
  await x.warm();
  const result = await x.adapter.subscribeOrderBook({ instrumentId: x.symbol, depth }, x.context());
  if (!result.ok) throw new Error(result.error.code);
  const stream = result.value,
    iterator = stream[Symbol.asyncIterator]();
  function emit(version: string | null, time = now, quantity = '1', numeric = false, suffix = '2') {
    let text = JSON.stringify({
      ch: `market.${x.symbol}.depth.step0`,
      tick: {
        ...(version === null ? {} : { version }),
        ts: time,
        bids: [
          ['50000', quantity],
          ['49999', suffix],
        ],
        asks: [['50001', '2']],
      },
    });
    // Native numeric lexemes must reach parseWireJson before any Number coercion.
    if (numeric) text = text.replace(`"version":"${version}"`, `"version":${version}`);
    x.state.message?.(text);
  }
  async function data(sequence: string | null, time = now) {
    expect(await iterator.next()).toMatchObject({
      value: { kind: 'DATA', data: { sourceSequence: sequence, exchangeTime: time } },
    });
  }
  async function gap() {
    expect(stream.health().status).toBe('RESYNC_REQUIRED');
    expect(stream.health().queued).toBe(0);
    expect(await iterator.next()).toMatchObject({ value: { kind: 'RESYNC_REQUIRED' } });
    expect(x.state.socketClosed).toBe(1);
    expect(x.openSocket).toHaveBeenCalledTimes(1);
  }
  return { x, stream, emit, data, gap };
}

describe.each(htxProfileIds)('HTX book snapshot ordering %s', (profile) => {
  it('version 100 → 99 with a newer timestamp requires resync', async () => {
    const b = await book(profile);
    b.emit('100');
    await b.data('100');
    b.emit('99', now + 1);
    await b.gap();
  });
  it('adjacent large native numeric versions compare losslessly on regression', async () => {
    const b = await book(profile);
    b.emit('9007199254740993', now, '1', true);
    await b.data('9007199254740993');
    b.emit('9007199254740992', now + 1, '1', true);
    await b.gap();
  });
  it('adjacent large native numeric versions compare losslessly on progression', async () => {
    const b = await book(profile);
    b.emit('9007199254740992', now, '1', true);
    await b.data('9007199254740992');
    b.emit('9007199254740993', now + 1, '1', true);
    await b.data('9007199254740993', now + 1);
    expect(b.stream.health().status).toBe('ACTIVE');
  });
  it('version 9 → 10 is numeric progression rather than lexical regression', async () => {
    const b = await book(profile);
    b.emit('9');
    await b.data('9');
    b.emit('10', now + 1);
    await b.data('10', now + 1);
  });
  it('equal version and identical payload is ignored despite a later receipt', async () => {
    const b = await book(profile);
    b.emit('100');
    await b.data('100');
    b.x.state.time++;
    b.emit('100');
    expect(b.stream.health()).toMatchObject({ status: 'ACTIVE', queued: 0 });
    b.emit('101', now + 1);
    await b.data('101', now + 1);
  });
  it('equal version and different full payload requires resync', async () => {
    const b = await book(profile);
    b.emit('100');
    await b.data('100');
    b.emit('100', now, '2');
    await b.gap();
  });
  it('greater version at the same timestamp is accepted', async () => {
    const b = await book(profile);
    b.emit('100');
    await b.data('100');
    b.emit('101');
    await b.data('101');
  });
  it('a previously seen older version cannot bypass ordering as a duplicate', async () => {
    const b = await book(profile);
    b.emit('100');
    await b.data('100');
    b.emit('101', now + 1);
    await b.data('101', now + 1);
    b.emit('100');
    await b.gap();
  });
  it('an unversioned timestamp regression requires resync', async () => {
    const b = await book(profile);
    b.emit(null);
    await b.data(null);
    b.emit(null, now - 1);
    await b.gap();
  });
  it('equal unversioned timestamp and identical snapshot is ignored', async () => {
    const b = await book(profile);
    b.emit(null);
    await b.data(null);
    b.x.state.time++;
    b.emit(null);
    expect(b.stream.health()).toMatchObject({ status: 'ACTIVE', queued: 0 });
    b.emit(null, now + 1);
    await b.data(null, now + 1);
  });
  it('equal unversioned timestamp and different snapshot requires resync', async () => {
    const b = await book(profile);
    b.emit(null);
    await b.data(null);
    b.emit(null, now, '2');
    await b.gap();
  });
  it('a greater unversioned timestamp is accepted', async () => {
    const b = await book(profile);
    b.emit(null);
    await b.data(null);
    b.emit(null, now + 1);
    await b.data(null, now + 1);
  });
  it('unversioned conflict outside the requested depth still requires resync', async () => {
    const b = await book(profile, 1);
    b.emit(null);
    await b.data(null);
    b.emit(null, now, '1', false, '3');
    await b.gap();
  });
  it('a greater version does not weaken the existing timestamp regression guard', async () => {
    const b = await book(profile);
    b.emit('100');
    await b.data('100');
    b.emit('101', now - 1);
    await b.gap();
  });
  it('an unversioned frame does not reset the last observed native version', async () => {
    const b = await book(profile);
    b.emit('100');
    await b.data('100');
    b.emit(null, now + 1);
    await b.data(null, now + 1);
    b.emit('99', now + 2);
    await b.gap();
  });
  it('metadata replacement is checked before ignoring an identical duplicate', async () => {
    const b = await book(profile),
      r = b.x.options.registry.get(b.x.endpoint.scope, b.x.symbol, now);
    if (!r.ok) throw new Error();
    b.emit('100');
    await b.data('100');
    expect(
      (
        await b.x.options.registry.put(
          {
            instrument: { ...r.value.instrument, metadataVersion: 'replacement-meta' },
            rules: { ...r.value.rules, version: 'replacement-rules' },
          },
          now,
        )
      ).ok,
    ).toBe(true);
    b.emit('100');
    await b.gap();
  });
  it.each(['invalid', '-1', '1.5', '1e3', '01'])(
    'noncanonical unsigned native version %s fails closed',
    async (version) => {
      const b = await book(profile);
      b.emit(version);
      await b.gap();
    },
  );
});
