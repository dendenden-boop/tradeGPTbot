import { randomBytes } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';

export type PasswordErrorCode =
  'PASSWORD_BUSY' | 'PASSWORD_CLOSED' | 'PASSWORD_INVALID' | 'PASSWORD_UNAVAILABLE';

export class PasswordError extends Error {
  constructor(readonly code: PasswordErrorCode) {
    super(code);
    this.name = 'PasswordError';
  }
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encoded: string | null, password: string): Promise<boolean>;
  close(): Promise<void>;
}

export const passwordHashOptions = Object.freeze({
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  version: 0x13,
});

// The library owns PHC decoding. This check only bounds work before native code,
// including when a stored credential is corrupt or has unsupported cost settings.
function supportedHash(encoded: string): boolean {
  if (encoded.length > 256) return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'argon2id' || parts[2] !== 'v=19') {
    return false;
  }
  const parameters = parts[3]?.split(',').sort().join(',');
  return (
    parameters === 'm=65536,p=1,t=3' &&
    /^[A-Za-z0-9+/]{22}$/.test(parts[4] ?? '') &&
    /^[A-Za-z0-9+/]{43}$/.test(parts[5] ?? '')
  );
}

function checkPassword(password: string): void {
  if (typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password) > 512) {
    throw new PasswordError('PASSWORD_INVALID');
  }
}

export async function createPasswordHasher(): Promise<PasswordHasher> {
  // Complete dummy initialization before accepting requests. Each unknown or
  // malformed credential then does one verification, with no nested queue work.
  let dummyHash: string;
  try {
    dummyHash = await hash(randomBytes(32), passwordHashOptions);
  } catch {
    throw new PasswordError('PASSWORD_UNAVAILABLE');
  }
  let closed = false;
  let running = 0;
  let closePromise: Promise<void> | undefined;
  const queue: { start(): void; reject(error: PasswordError): void }[] = [];
  const drain: (() => void)[] = [];

  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new PasswordError('PASSWORD_CLOSED'));
    if (running >= 2 && queue.length >= 8) {
      return Promise.reject(new PasswordError('PASSWORD_BUSY'));
    }
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        running += 1;
        void Promise.resolve()
          .then(operation)
          .then(resolve, () => reject(new PasswordError('PASSWORD_UNAVAILABLE')))
          .finally(() => {
            running -= 1;
            if (!closed) queue.shift()?.start();
            if (running === 0 && queue.length === 0) drain.splice(0).forEach((done) => done());
          });
      };
      if (running < 2) start();
      else queue.push({ start, reject });
    });
  }

  return {
    async hash(password) {
      checkPassword(password);
      return run(() => hash(password, passwordHashOptions));
    },
    async verify(encoded, password) {
      checkPassword(password);
      if (encoded !== null && !supportedHash(encoded)) {
        // Treat corrupt credentials like an unknown account, without allowing
        // untrusted PHC cost parameters to allocate arbitrary native memory.
        await run(() => verify(dummyHash, password));
        return false;
      }
      const selectedHash = encoded ?? dummyHash;
      const matches = await run(() => verify(selectedHash, password));
      return encoded !== null && matches;
    },
    close() {
      if (!closePromise) {
        closed = true;
        queue.splice(0).forEach((job) => job.reject(new PasswordError('PASSWORD_CLOSED')));
        closePromise =
          running === 0 ? Promise.resolve() : new Promise<void>((resolve) => drain.push(resolve));
      }
      return closePromise;
    },
  };
}
