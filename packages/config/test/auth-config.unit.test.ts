import { describe, expect, it } from 'vitest';
import { ConfigError, loadAuthConfig, loadConfig } from '../src/index.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://runtime:abc@127.0.0.1:5432/ctp',
  REDIS_URL: 'redis://:abc@127.0.0.1:6379/0',
};
const valid = {
  DATABASE_AUTH_URL: 'postgresql://auth:abc@127.0.0.1:5432/ctp',
  AUTH_ORIGIN: 'http://127.0.0.1:3000',
  AUTH_CSRF_SECRET: '13a4b52df689c70e13a4b52df689c70e13a4b52df689c70e13a4b52df689c70e',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_REQUIRE_TLS: 'false',
  SMTP_FROM: 'accounts@ctp.invalid',
};
const app = loadConfig(base);

describe('authentication configuration boundary', () => {
  it('uses explicit credentials and immutable mail settings', () => {
    const result = loadAuthConfig(valid, app);
    expect(result.cookieSecure).toBe(false);
    expect(result.smtp).toMatchObject({ port: 1025, secure: false, requireTls: false });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.smtp)).toBe(true);
  });
  it.each([
    ['AUTH_ORIGIN', 'http://example.com'],
    ['AUTH_ORIGIN', 'http://127.0.0.1:3000/'],
    ['AUTH_ORIGIN', 'https://site.invalid/path'],
    ['AUTH_ORIGIN', 'https://site.invalid?q=x'],
    ['AUTH_ORIGIN', 'https://user:password@site.invalid'],
    ['AUTH_ORIGIN', 'https://site.invalid#token'],
    ['AUTH_ORIGIN', 'https://site.invalid\n'],
    ['AUTH_CSRF_SECRET', 'a'.repeat(64)],
    ['AUTH_CSRF_SECRET', '13a4b52df689c70e'],
    ['DATABASE_AUTH_URL', base.DATABASE_URL],
    ['DATABASE_AUTH_URL', 'postgresql://auth:abc@127.0.0.1:5432/other'],
    ['DATABASE_AUTH_URL', 'postgresql://auth:abc@elsewhere:5432/ctp'],
    ['DATABASE_AUTH_URL', 'postgresql://auth:abc@127.0.0.1:5432/ctp?options=admin'],
    ['DATABASE_AUTH_URL', 'postgresql://auth@127.0.0.1:5432/ctp'],
    ['SMTP_HOST', 'smtp.invalid\r\nEHLO attacker'],
    ['SMTP_PORT', '0'],
    ['SMTP_PORT', '65536'],
    ['SMTP_SECURE', '1'],
    ['SMTP_REQUIRE_TLS', ''],
    ['SMTP_FROM', 'sender@ctp.invalid\r\nBcc: attacker@invalid'],
    ['SMTP_USER', 'user'],
    ['SMTP_PASSWORD', 'password'],
  ])('rejects unsafe %s without including its value', (field, value) => {
    let error: unknown;
    try {
      loadAuthConfig({ ...valid, [field]: value }, app);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).fields).toContain(field);
    if (value.length > 0) expect((error as Error).message).not.toContain(value);
  });
  it('does not evaluate environment accessors or accept inherited settings', () => {
    const input = { ...valid };
    Object.defineProperty(input, 'AUTH_CSRF_SECRET', {
      get() {
        throw new Error('secret canary');
      },
    });
    expect(() => loadAuthConfig(input, app)).toThrow('Invalid configuration: AUTH_CSRF_SECRET');
    expect(() => loadAuthConfig(Object.create(valid) as typeof valid, app)).toThrow(ConfigError);
  });
  it('requires all auth settings at startup', () => {
    expect(() => loadAuthConfig({}, app)).toThrow(ConfigError);
  });
  it('requires HTTPS, TLS mail and separately authenticated TLS database in deployments', () => {
    const deployed = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://runtime:a831942ecd7f82015abd@db:5432/ctp?sslmode=verify-full',
      REDIS_URL: 'rediss://:a831942ecd7f82015abd@redis:6379/0',
    });
    const input = {
      ...valid,
      AUTH_ORIGIN: 'https://ctp.invalid',
      DATABASE_AUTH_URL: 'postgresql://auth:b931942ecd7f82015abd@db:5432/ctp?sslmode=verify-full',
      SMTP_REQUIRE_TLS: 'true',
    };
    expect(loadAuthConfig(input, deployed).cookieSecure).toBe(true);
    expect(() => loadAuthConfig({ ...input, SMTP_REQUIRE_TLS: 'false' }, deployed)).toThrow(
      ConfigError,
    );
    expect(() => loadAuthConfig({ ...input, AUTH_ORIGIN: valid.AUTH_ORIGIN }, deployed)).toThrow(
      ConfigError,
    );
    expect(() =>
      loadAuthConfig(
        { ...input, DATABASE_AUTH_URL: input.DATABASE_AUTH_URL.replace('verify-full', 'require') },
        deployed,
      ),
    ).toThrow(ConfigError);
  });
});
