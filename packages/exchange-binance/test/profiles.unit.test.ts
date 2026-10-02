import { describe, expect, it } from 'vitest';
import { getBinanceProfile, publicStreamUrl } from '../src/profiles.js';
describe('server-controlled Binance destinations', () => {
  it('keeps Spot Testnet and Demo entirely separate', () => {
    const a = getBinanceProfile('binance-spot-testnet-v1'),
      b = getBinanceProfile('binance-spot-demo-v1');
    expect(a.scope.environment).toBe('TESTNET');
    expect(b.scope.environment).toBe('DEMO');
    expect(a.rest).not.toBe(b.rest);
    expect(a.privateWs).not.toBe(b.privateWs);
    expect(Object.isFrozen(a.scope)).toBe(true);
  });
  it.each([
    'https://api.binance.com',
    'http://127.0.0.1',
    'binance-usdm-demo-v1',
    'binance-usdm-testnet-v1\n',
    null,
    {},
  ])('refuses an arbitrary destination %j', (value) => {
    expect(() => getBinanceProfile(value)).toThrow('INVALID_BINANCE_PROFILE');
  });
  it('uses exact routed futures paths and documented Spot combined endpoint', () => {
    const a = getBinanceProfile('binance-usdm-live-v1');
    expect(publicStreamUrl(a, 'BTCUSDT', 'ticker').href).toBe(
      'wss://fstream.binance.com/market/ws/btcusdt@ticker',
    );
    expect(publicStreamUrl(a, 'BTCUSDT', 'depth20@100ms', true).href).toBe(
      'wss://fstream.binance.com/public/ws/btcusdt@depth20@100ms',
    );
    expect(
      publicStreamUrl(getBinanceProfile('binance-spot-testnet-v1'), 'BTCUSDT', 'aggTrade').href,
    ).toBe('wss://stream.testnet.binance.vision/stream?streams=btcusdt@aggTrade');
  });
  it.each(['../../orders', 'btcusdt', 'BTCUSDT?signature=x', 'BTCUSDT\n'])(
    'rejects URL injection through symbol %s',
    (symbol) => {
      expect(() =>
        publicStreamUrl(getBinanceProfile('binance-spot-testnet-v1'), symbol, 'ticker'),
      ).toThrow();
    },
  );
  it('leaves unverified USD-M sandbox private routing disabled', () => {
    expect(getBinanceProfile('binance-usdm-testnet-v1').privateWsVerified).toBe(false);
  });
});
