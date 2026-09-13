import { describe, expect, it } from 'vitest';
import { sanitize } from './docker-test-utils.mjs';

describe('owned Docker diagnostic redaction', () => {
  const childPassword = 'ab'.repeat(24);
  it.each([
    [
      `CREATE ROLE fixture PASSWORD '${childPassword}'`,
      "CREATE ROLE fixture PASSWORD '[REDACTED]'",
    ],
    [
      `postgresql://fixture:${childPassword.toUpperCase()}@localhost/db`,
      'postgresql://fixture:[REDACTED]@localhost/db',
    ],
    [`{"password":"${childPassword}"}`, '{"password":"[REDACTED]"}'],
    [`prefix_${childPassword}_suffix`, 'prefix_[REDACTED]_suffix'],
  ])('redacts a child credential in %s', (input, expected) => {
    expect(sanitize(input, [])).toBe(expected);
  });

  it('also redacts explicitly supplied credentials of a different format', () => {
    expect(sanitize('credential=synthetic-test-secret', ['synthetic-test-secret'])).toBe(
      'credential=[REDACTED]',
    );
  });

  it('preserves image digests and UUIDs needed to diagnose the owned run', () => {
    const input = `sha256:${'ab'.repeat(32)} 11111111-2222-4333-8444-555555555555`;
    expect(sanitize(input, [])).toBe(input);
  });
});
