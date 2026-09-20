import { beforeEach, describe, expect, it, vi } from 'vitest';

const library = vi.hoisted(() => ({ hash: vi.fn(), verify: vi.fn() }));
vi.mock('argon2', () => ({ argon2id: 2, hash: library.hash, verify: library.verify }));

import { createPasswordHasher } from '../src/password.js';

const encoded =
  '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('password native work budget', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts only two operations, caps the queue and drains native work on close', async () => {
    library.hash.mockResolvedValueOnce(encoded);
    const hasher = await createPasswordHasher();
    const finish: ((value: string) => void)[] = [];
    library.hash.mockImplementation(() => new Promise<string>((resolve) => finish.push(resolve)));
    const work = Array.from({ length: 10 }, () => hasher.hash('valid test password'));
    // Attach handlers before shutdown rejects queued callers.
    const settled = Promise.allSettled(work);
    await expect(hasher.hash('overflow password')).rejects.toMatchObject({ code: 'PASSWORD_BUSY' });
    expect(library.hash).toHaveBeenCalledTimes(3); // initialization plus two active jobs
    let closed = false;
    const closing = hasher.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish[0]?.(encoded);
    await Promise.resolve();
    expect(closed).toBe(false);
    finish[1]?.(encoded);
    await closing;
    const results = await settled;
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(2);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(8);
    await expect(hasher.hash('after close password')).rejects.toMatchObject({
      code: 'PASSWORD_CLOSED',
    });
    await hasher.close();
  });

  it('performs one dummy verification and never passes corrupt cost parameters to native code', async () => {
    library.hash.mockResolvedValue(encoded);
    library.verify.mockResolvedValue(false);
    const hasher = await createPasswordHasher();
    await expect(hasher.verify('corrupt secret stored hash', 'test password')).resolves.toBe(false);
    expect(library.hash).toHaveBeenCalledTimes(1);
    expect(library.verify).toHaveBeenCalledExactlyOnceWith(encoded, 'test password');
    await hasher.close();
  });

  it('does not leak library exceptions from initialization or work', async () => {
    library.hash.mockRejectedValueOnce(new Error('native error: secret password'));
    await expect(createPasswordHasher()).rejects.toMatchObject({ message: 'PASSWORD_UNAVAILABLE' });
    library.hash.mockResolvedValueOnce(encoded);
    const hasher = await createPasswordHasher();
    library.hash.mockRejectedValueOnce(new Error('native error: secret password'));
    await expect(hasher.hash('secret password')).rejects.toMatchObject({
      message: 'PASSWORD_UNAVAILABLE',
    });
    await hasher.close();
  });
});
