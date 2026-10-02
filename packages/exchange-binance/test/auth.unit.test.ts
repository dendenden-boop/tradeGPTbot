import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AccountScope } from '@ctp/exchange-core';
import { createBinanceSigner, resolveBinanceBinding } from '../src/auth.js';
import type { BinanceClockSample } from '../src/auth.js';
import type { IoContext } from '../src/io.js';
import type { BinanceCredentialPort } from '../src/ports.js';
import { getBinanceProfile } from '../src/profiles.js';

const endpoint = getBinanceProfile('binance-spot-testnet-v1');
const account: AccountScope = {
  tenantId: 'c1e4cf33-31cb-4bd8-bd05-6355d82dde70',
  connectionId: 'bba912d4-0cb0-487f-bbb3-7ca77fe1a8b7',
  externalAccountId: 'server-account',
};
const apiKey = 'test-api-key-sentinel';
const secret = 'test-secret-sentinel';
const binding = { profileId: endpoint.id, account, credentialRef: 'vault-reference' };
const context = (now: number, signal = new AbortController().signal): IoContext => ({
  signal,
  deadline: now + 1000,
});
const port = () => ({
  resolve: vi.fn(() => Promise.resolve({ profileId: endpoint.id, account, apiKey, secret })),
});
const sample = (now: number): BinanceClockSample => ({
  serverTime: now,
  sampledAt: now,
  roundTripMs: 0,
});

describe('server credential binding', () => {
  it('permits public-only construction without connection authority', () => {
    expect(resolveBinanceBinding(endpoint, undefined)).toBeNull();
  });
  it('captures an immutable trusted connection result', () => {
    const mutable = { account: { ...account }, credentialRef: 'vault-reference' };
    const result = resolveBinanceBinding(endpoint, { resolve: () => mutable });
    mutable.account.externalAccountId = 'later';
    expect(result).toEqual(binding);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.account)).toBe(true);
  });
  it.each(['https://vault.test/key', 'raw key', '', 'vault\nkey', 'x'.repeat(129)])(
    'rejects invalid credential reference %s',
    (credentialRef) => {
      expect(() =>
        resolveBinanceBinding(endpoint, { resolve: () => ({ account, credentialRef }) }),
      ).toThrow('SCOPE_MISMATCH');
    },
  );
  it.each(['tenantId', 'connectionId', 'externalAccountId'] as const)(
    'rejects malformed account field %s',
    (field) => {
      expect(() =>
        resolveBinanceBinding(endpoint, {
          resolve: () => ({
            account: { ...account, [field]: '' },
            credentialRef: 'vault-reference',
          }),
        }),
      ).toThrow('SCOPE_MISMATCH');
    },
  );
  it('does not echo a server resolver exception or sensitive cause', () => {
    let caught: unknown;
    try {
      resolveBinanceBinding(endpoint, {
        resolve: () => {
          throw new Error(secret);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ message: 'SCOPE_MISMATCH', code: 'SCOPE_MISMATCH' });
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(caught).not.toHaveProperty('cause');
  });
});

describe('Binance REST HMAC contract', () => {
  it('matches the official Spot ASCII signing vector with signature last', async () => {
    const now = 1499827319559;
    const officialSecret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
    const credentials: BinanceCredentialPort = {
      resolve: () =>
        Promise.resolve({ profileId: endpoint.id, account, apiKey, secret: officialSecret }),
    };
    const signer = createBinanceSigner(
      endpoint,
      binding,
      credentials,
      () => sample(now),
      () => now,
    );
    const signed = await signer.signRest(
      {
        symbol: 'LTCBTC',
        side: 'BUY',
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity: '1',
        price: '0.1',
      },
      context(now),
    );
    expect(signed.params.signature).toBe(
      'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71',
    );
    expect(new URLSearchParams(signed.params).toString()).toBe(
      'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559&signature=c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71',
    );
    expect(signed.headers).toEqual({ 'X-MBX-APIKEY': apiKey });
    expect(Object.isFrozen(signed.params)).toBe(true);
  });
  it('matches the official USD-M vector', async () => {
    const futures = getBinanceProfile('binance-usdm-testnet-v1');
    const now = 1591702613943;
    const credentials: BinanceCredentialPort = {
      resolve: () =>
        Promise.resolve({
          profileId: futures.id,
          account,
          apiKey,
          secret: '2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9',
        }),
    };
    const signer = createBinanceSigner(
      futures,
      { ...binding, profileId: futures.id },
      credentials,
      () => sample(now),
      () => now,
    );
    const signed = await signer.signRest(
      {
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        price: '9000',
        timeInForce: 'GTC',
      },
      context(now),
    );
    expect(signed.params.signature).toBe(
      '3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9',
    );
  });
  it('signs the exact percent-encoded bytes used by URLSearchParams', async () => {
    const now = 100000;
    const signer = createBinanceSigner(
      endpoint,
      binding,
      port(),
      () => sample(now),
      () => now,
    );
    const params = { symbol: '１２３４５６', clientOrderId: 'a b+c&d=e/%' };
    const signed = await signer.signRest(params, context(now));
    const query = new URLSearchParams(signed.params);
    const signature = query.get('signature');
    query.delete('signature');
    expect(query.toString()).toBe(
      'symbol=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96&clientOrderId=a+b%2Bc%26d%3De%2F%25&recvWindow=5000&timestamp=100000',
    );
    expect(signature).toBe(createHmac('sha256', secret).update(query.toString()).digest('hex'));
  });
  it.each(['signature', 'timestamp', 'recvWindow', 'apiKey', '__proto__', 'invalid-key'])(
    'refuses caller override or invalid parameter %s',
    (key) => {
      const now = 100000;
      const credentials = port();
      const signer = createBinanceSigner(
        endpoint,
        binding,
        credentials,
        () => sample(now),
        () => now,
      );
      return expect(signer.signRest({ [key]: 'sentinel' }, context(now)))
        .rejects.toThrow('INVALID_REQUEST')
        .then(() => {
          expect(credentials.resolve).not.toHaveBeenCalled();
        });
    },
  );
  it('refuses raw values outside the internal string wire contract', async () => {
    const now = 100000;
    const signer = createBinanceSigner(
      endpoint,
      binding,
      port(),
      () => sample(now),
      () => now,
    );
    await expect(
      signer.signRest({ quantity: 0.1 } as unknown as Record<string, string>, context(now)),
    ).rejects.toThrow('INVALID_REQUEST');
    await expect(signer.signRest({ quantity: 'x'.repeat(8193) }, context(now))).rejects.toThrow(
      'INVALID_REQUEST',
    );
  });
});

describe('credential authority and bounded cancellation', () => {
  it.each(['profileId', 'tenantId', 'connectionId', 'externalAccountId'] as const)(
    'rejects credential binding mismatch %s',
    async (field) => {
      const now = 100000;
      const credentials: BinanceCredentialPort = {
        resolve: () =>
          Promise.resolve({
            profileId: field === 'profileId' ? 'binance-spot-live-v1' : endpoint.id,
            account:
              field === 'profileId'
                ? account
                : {
                    ...account,
                    [field]:
                      field === 'externalAccountId'
                        ? 'other-account'
                        : 'd1e4cf33-31cb-4bd8-bd05-6355d82dde70',
                  },
            apiKey,
            secret,
          }),
      };
      const signer = createBinanceSigner(
        endpoint,
        binding,
        credentials,
        () => sample(now),
        () => now,
      );
      await expect(signer.signRest({}, context(now))).rejects.toThrow('SCOPE_MISMATCH');
    },
  );
  it('refuses private signing without server credentials and binding', async () => {
    const now = 100000;
    await expect(
      createBinanceSigner(
        endpoint,
        null,
        undefined,
        () => sample(now),
        () => now,
      ).signRest({}, context(now)),
    ).rejects.toThrow('AUTHORIZATION_REQUIRED');
  });
  it('checks abort before credential lookup', async () => {
    const now = 100000;
    const credentials = port();
    const controller = new AbortController();
    controller.abort(secret);
    const signer = createBinanceSigner(
      endpoint,
      binding,
      credentials,
      () => sample(now),
      () => now,
    );
    await expect(signer.signRest({}, context(now, controller.signal))).rejects.toThrow('ABORTED');
    expect(credentials.resolve).not.toHaveBeenCalled();
  });
  it('checks elapsed deadline before credential lookup', async () => {
    const now = 100000;
    const credentials = port();
    const signer = createBinanceSigner(
      endpoint,
      binding,
      credentials,
      () => sample(now),
      () => now,
    );
    await expect(signer.signRest({}, { ...context(now), deadline: now })).rejects.toThrow(
      'DEADLINE_EXCEEDED',
    );
    expect(credentials.resolve).not.toHaveBeenCalled();
  });
  it('refuses an unbounded lookup deadline before calling the credential port', async () => {
    const now = 100000;
    const credentials = port();
    const signer = createBinanceSigner(
      endpoint,
      binding,
      credentials,
      () => sample(now),
      () => now,
    );
    await expect(signer.signRest({}, { ...context(now), deadline: now + 30001 })).rejects.toThrow(
      'INVALID_REQUEST',
    );
    expect(credentials.resolve).not.toHaveBeenCalled();
  });
  it('settles a hung credential lookup after abort and safely consumes late rejection', async () => {
    const now = Date.now();
    let reject: (reason: unknown) => void = () => {};
    const credentials: BinanceCredentialPort = {
      resolve: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    };
    const controller = new AbortController();
    const signer = createBinanceSigner(endpoint, binding, credentials, () => sample(now), Date.now);
    const pending = signer.signRest({}, context(now, controller.signal));
    controller.abort(secret);
    await expect(pending).rejects.toThrow('ABORTED');
    reject(new Error(secret));
    await Promise.resolve();
  });
  it('settles a hung credential lookup at a real deadline', async () => {
    const now = Date.now();
    const credentials: BinanceCredentialPort = { resolve: () => new Promise(() => {}) };
    const signer = createBinanceSigner(endpoint, binding, credentials, () => sample(now), Date.now);
    await expect(signer.signRest({}, { ...context(now), deadline: now + 30 })).rejects.toThrow(
      'DEADLINE_EXCEEDED',
    );
    expect(Date.now() - now).toBeLessThan(500);
  });
  it('checks abort after asynchronous credential resolution', async () => {
    const now = 100000;
    const controller = new AbortController();
    const credentials: BinanceCredentialPort = {
      resolve: () => {
        controller.abort();
        return Promise.resolve({ profileId: endpoint.id, account, apiKey, secret });
      },
    };
    const signer = createBinanceSigner(
      endpoint,
      binding,
      credentials,
      () => sample(now),
      () => now,
    );
    await expect(signer.signRest({}, context(now, controller.signal))).rejects.toThrow('ABORTED');
  });
  it('checks deadline after asynchronous credential resolution', async () => {
    let now = 100000;
    const initial = now;
    const credentials: BinanceCredentialPort = {
      resolve: () => {
        now += 1001;
        return Promise.resolve({ profileId: endpoint.id, account, apiKey, secret });
      },
    };
    const signer = createBinanceSigner(
      endpoint,
      binding,
      credentials,
      () => sample(now),
      () => now,
    );
    await expect(signer.signRest({}, context(initial))).rejects.toThrow('DEADLINE_EXCEEDED');
  });
  it('resolves each operation without caching secrets and captures account authority', async () => {
    const now = 100000;
    const credentials = port();
    const mutableBinding = { ...binding, account: { ...account } };
    const signer = createBinanceSigner(
      endpoint,
      mutableBinding,
      credentials,
      () => sample(now),
      () => now,
    );
    mutableBinding.account.externalAccountId = 'changed-after-construction';
    await signer.signRest({}, context(now));
    await signer.apiKeyHeaders(context(now));
    expect(credentials.resolve).toHaveBeenCalledTimes(2);
    expect(credentials.resolve).toHaveBeenLastCalledWith(
      'vault-reference',
      endpoint.id,
      account,
      expect.any(Object),
    );
  });
  it('sanitizes rejected credential lookup and hostile returned credentials', async () => {
    const now = 100000;
    const credentials: BinanceCredentialPort = {
      resolve: () => Promise.reject(new Error(`${apiKey} ${secret}`)),
    };
    const signer = createBinanceSigner(
      endpoint,
      binding,
      credentials,
      () => sample(now),
      () => now,
    );
    const error: unknown = await signer
      .signRest({}, context(now))
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: 'AUTHORIZATION_REQUIRED',
      code: 'AUTHORIZATION_REQUIRED',
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(error).not.toHaveProperty('cause');
  });
  it.each(['\r\nX-Key: injected', '', 'x'.repeat(257)])(
    'rejects a credential header unsafe value %s',
    (unsafeKey) => {
      const now = 100000;
      const credentials: BinanceCredentialPort = {
        resolve: () =>
          Promise.resolve({ profileId: endpoint.id, account, apiKey: unsafeKey, secret }),
      };
      return expect(
        createBinanceSigner(
          endpoint,
          binding,
          credentials,
          () => sample(now),
          () => now,
        ).apiKeyHeaders(context(now)),
      ).rejects.toThrow('AUTHORIZATION_REQUIRED');
    },
  );
});

describe('fresh server clock and Spot signed subscription', () => {
  it('derives time from bounded server sample and half round-trip uncertainty', async () => {
    const now = 100500;
    const signer = createBinanceSigner(
      endpoint,
      binding,
      port(),
      () => ({ serverTime: 200000, sampledAt: 100000, roundTripMs: 100 }),
      () => now,
    );
    const signed = await signer.signRest({}, context(now));
    expect(signed.params.timestamp).toBe('200550');
    expect(signed.params.recvWindow).toBe('5000');
  });
  it.each([
    null,
    { serverTime: 200000, sampledAt: 69999, roundTripMs: 0 },
    { serverTime: 200000, sampledAt: 100001, roundTripMs: 0 },
    { serverTime: 200000, sampledAt: 100000, roundTripMs: 1001 },
    { serverTime: -1, sampledAt: 100000, roundTripMs: 0 },
    { serverTime: 200000.1, sampledAt: 100000, roundTripMs: 0 },
  ])('rejects unverified or stale sample %j', (clock) => {
    const now = 100000;
    const signer = createBinanceSigner(
      endpoint,
      binding,
      port(),
      () => clock,
      () => now,
    );
    return expect(signer.signRest({}, context(now))).rejects.toThrow('STALE_METADATA');
  });
  it('creates HMAC signature subscription using alphabetically sorted parameters', async () => {
    const now = 100000;
    const signer = createBinanceSigner(
      endpoint,
      binding,
      port(),
      () => sample(now),
      () => now,
    );
    const request = await signer.spotSubscription('subscription-request', context(now));
    expect(request).toEqual({
      id: 'subscription-request',
      method: 'userDataStream.subscribe.signature',
      params: {
        apiKey,
        recvWindow: 5000,
        timestamp: now,
        signature: createHmac('sha256', secret)
          .update(`apiKey=${apiKey}&recvWindow=5000&timestamp=100000`)
          .digest('hex'),
      },
    });
    expect(JSON.stringify(request)).not.toContain(secret);
  });
  it('refuses Spot subscription on a futures profile', async () => {
    const futures = getBinanceProfile('binance-usdm-testnet-v1');
    const now = 100000;
    const signer = createBinanceSigner(
      futures,
      { ...binding, profileId: futures.id },
      port(),
      () => sample(now),
      () => now,
    );
    await expect(signer.spotSubscription('request', context(now))).rejects.toThrow('UNSUPPORTED');
  });
  it.each(['', 'request\n', 'x'.repeat(129)])(
    'rejects malformed subscription correlation %s',
    (id) => {
      const now = 100000;
      const signer = createBinanceSigner(
        endpoint,
        binding,
        port(),
        () => sample(now),
        () => now,
      );
      return expect(signer.spotSubscription(id, context(now))).rejects.toThrow('INVALID_REQUEST');
    },
  );
});
