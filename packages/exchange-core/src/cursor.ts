import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { idSchema, timestampSchema } from './scope.js';

const envelopeSchema = z.strictObject({
  raw: idSchema,
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: timestampSchema,
});
function hash(binding: string): string {
  return createHash('sha256').update(binding).digest('hex');
}

/** Per-adapter opaque cursors; restart invalidates them instead of broadening their scope. */
export function createCursorCodec() {
  const key = randomBytes(32);
  return Object.freeze({
    encode(raw: string, binding: string, now: number): string {
      const body = envelopeSchema.parse({ raw, binding: hash(binding), expiresAt: now + 300_000 });
      const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
      return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
    },
    decode(token: string, binding: string, now: number): string | null {
      if (
        typeof token !== 'string' ||
        token.length > 2048 ||
        !timestampSchema.safeParse(now).success
      )
        return null;
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match?.[1] || !match[2]) return null;
      const expected = createHmac('sha256', key).update(match[1]).digest();
      const signature = Buffer.from(match[2], 'base64url');
      if (
        signature.length !== expected.length ||
        signature.toString('base64url') !== match[2] ||
        !timingSafeEqual(signature, expected)
      )
        return null;
      try {
        const payload = Buffer.from(match[1], 'base64url');
        if (payload.toString('base64url') !== match[1]) return null;
        const decoded: unknown = JSON.parse(payload.toString('utf8'));
        const parsed = envelopeSchema.safeParse(decoded);
        return parsed.success &&
          parsed.data.binding === hash(binding) &&
          parsed.data.expiresAt > now &&
          parsed.data.expiresAt <= now + 300_000
          ? parsed.data.raw
          : null;
      } catch {
        return null;
      }
    },
  });
}
