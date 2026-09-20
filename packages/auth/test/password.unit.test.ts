import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../src/password.js';
import type { PasswordHasher } from '../src/password.js';

describe('real Argon2id password hashing', () => {
  let hasher: PasswordHasher;
  beforeAll(async () => {
    hasher = await createPasswordHasher();
  });
  afterAll(async () => {
    await hasher.close();
  });

  it('uses the required work factor and independent salts, and verifies without normalization', async () => {
    const password = '  пароль e\u0301 🔑 secret  ';
    const [first, second] = await Promise.all([hasher.hash(password), hasher.hash(password)]);
    expect(first).toMatch(/^\$argon2id\$v=19\$/);
    expect(first.split('$')[3]?.split(',').sort()).toEqual(['m=65536', 'p=1', 't=3']);
    expect(first).not.toBe(second);
    expect(await hasher.verify(first, password)).toBe(true);
    expect(await hasher.verify(first, password.trim())).toBe(false);
    expect(await hasher.verify(first, password.normalize('NFC'))).toBe(false);
  });

  it('does dummy verification for unknown, malformed and unbounded-cost credentials', async () => {
    for (const stored of [
      null,
      'broken-credential',
      '$argon2id$v=19$m=999999999,t=999999999,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      expect(await hasher.verify(stored, 'arbitrary valid password')).toBe(false);
    }
  });

  it('bounds input bytes before native allocation', async () => {
    await expect(hasher.hash('')).rejects.toMatchObject({ code: 'PASSWORD_INVALID' });
    await expect(hasher.hash('🔑'.repeat(129))).rejects.toMatchObject({ code: 'PASSWORD_INVALID' });
    const encoded = await hasher.hash('🔑'.repeat(128));
    expect(await hasher.verify(encoded, '🔑'.repeat(128))).toBe(true);
  });
});
