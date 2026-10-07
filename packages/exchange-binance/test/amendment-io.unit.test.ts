import { describe, expect, it } from 'vitest';
import { computeCommandHash, inPlaceAmendmentSchema } from '@ctp/exchange-core';
import { httpFixture, until } from './fixtures/io.js';
import { createNetworkIo } from '../src/io.js';
import { createRestClient } from '../src/client.js';
import { createBinanceSigner } from '../src/auth.js';
import { createPrivateTransport } from '../src/private-transport.js';
import { getBinanceProfile, adapterProfile } from '../src/profiles.js';
import { normalizeBinanceAdmission } from '../src/public-data.js';
import { spotSymbol } from './fixtures/public-data.js';
import {
  ACCOUNT,
  INTERNAL_ORDER_ID,
  INTENT_ID,
  newOrder,
  order,
  privateRecord,
} from './fixtures/private-data.js';

describe('native AMEND with actual underlying HTTP lifecycle', () => {
  it.each(['ABORT', 'DEADLINE'] as const)(
    'settles %s after PUT, destroys socket, retains UNKNOWN and recovers read capacity',
    async (kind) => {
      let t = Date.now();
      const calls: string[] = [];
      const native = {
        ...order(),
        orderListId: '-1',
        icebergQty: '0',
        origQuoteOrderQty: '0',
        usedSor: false,
        updateTime: String(t - 10),
      };
      let started!: () => void;
      const received = new Promise<void>((resolve) => {
        started = resolve;
      });
      const fixture = await httpFixture((req, res) => {
        calls.push(req.method!);
        if (req.method === 'PUT') {
          started();
          res.write('{');
        } else res.end(JSON.stringify(native));
      });
      // Native evidence starts after the asynchronous listener setup, so a
      // delayed fixture startup is not mistaken for a stale target admission.
      t = Date.now();
      native.updateTime = String(t - 10);
      const network = createNetworkIo();
      try {
        // Loopback profile override is an internal test injection, absent from production exports.
        const endpoint = {
          ...getBinanceProfile('binance-spot-testnet-v1'),
          rest: fixture.url.origin,
        };
        const binding = {
          profileId: endpoint.id,
          account: ACCOUNT,
          credentialRef: 'fixture-vault',
        };
        const profile = adapterProfile(endpoint, binding.credentialRef);
        const signer = createBinanceSigner(
          endpoint,
          binding,
          {
            resolve: () =>
              Promise.resolve({
                profileId: endpoint.id,
                account: ACCOUNT,
                apiKey: 'fixture',
                secret: 'fixture',
              }),
          },
          () => {
            const now = Date.now();
            return { serverTime: now, sampledAt: now, roundTripMs: 0 };
          },
          Date.now,
        );
        const client = createRestClient(
          endpoint,
          network,
          { reserve: () => Promise.resolve(true), observe: () => Promise.resolve() },
          ACCOUNT,
          Date.now,
        );
        const base = privateRecord(),
          record = {
            ...base,
            rules: { ...base.rules, effectiveAt: t - 1000, expiresAt: t + 10_000 },
          };
        const transport = createPrivateTransport({
          endpoint,
          binding,
          signer,
          client,
          record: () => record,
          admission: () => normalizeBinanceAdmission({ ...spotSymbol(), amendAllowed: true }),
          identities: {
            order: () => ({ internalOrderId: INTERNAL_ORDER_ID, intentId: INTENT_ID }),
            fill: () => ({ internalOrderId: INTERNAL_ORDER_ID }),
            algo: () => ({ internalAlgoId: INTERNAL_ORDER_ID }),
          },
          orderAdmission: { validate: () => Promise.resolve(true) },
          now: Date.now,
          syncTime: () => Promise.resolve(),
        });
        const command = inPlaceAmendmentSchema.parse({
          semantics: 'IN_PLACE',
          identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
          locator: {
            instrumentId: 'BTCUSDT',
            locator: { kind: 'EXCHANGE_ID', id: native.orderId },
          },
          target: {
            internalOrderId: INTERNAL_ORDER_ID,
            placeIntentId: INTENT_ID,
            revision: '1',
            observedAt: t,
            nativeUpdatedAt: t - 10,
            current: newOrder(),
            filledQuantity: '0.025',
          },
          replacement: {
            ...newOrder(),
            clientOrderId: 'fixture-amend-1',
            size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '0.075' },
          },
        });
        const controller = new AbortController(),
          deadline = Date.now() + (kind === 'DEADLINE' ? 500 : 2000);
        const pending = transport.request(
          'amendOrder',
          {
            command,
            authorization: {
              profile,
              account: ACCOUNT,
              commandId: INTENT_ID,
              dispatchAttemptId: INTERNAL_ORDER_ID,
              commandHash: computeCommandHash('amendOrder', command, { profile, account: ACCOUNT }),
              issuedAt: t,
              expiresAt: deadline,
            },
          },
          {
            profile,
            account: ACCOUNT,
            correlationId: 'native-amend-http',
            deadline,
            signal: controller.signal,
          },
        );
        await Promise.race([
          received,
          pending.then(() => {
            throw new Error('AMEND_FIXTURE_ENDED_BEFORE_PUT');
          }),
        ]);
        const abortAt = Date.now();
        if (kind === 'ABORT') controller.abort();
        expect(await pending).toMatchObject({
          kind: 'UNKNOWN',
          error: { code: kind === 'ABORT' ? 'ABORTED' : 'DEADLINE_EXCEEDED' },
        });
        expect(Date.now() - abortAt).toBeLessThan(1500);
        await until(() => fixture.sockets.size === 0);
        expect(calls).toEqual(['GET', 'PUT']);
        const recovered = await network.request(
          { url: fixture.url, method: 'GET' },
          { signal: new AbortController().signal, deadline: Date.now() + 1000 },
        );
        expect(recovered.status).toBe(200);
        expect(calls).toEqual(['GET', 'PUT', 'GET']);
        await until(() => fixture.sockets.size === 0);
      } finally {
        await network.close();
        await fixture.close();
      }
    },
  );
});
