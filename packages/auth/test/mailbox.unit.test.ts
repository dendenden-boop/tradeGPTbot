import { describe, expect, it } from 'vitest';
import { emailCorpus } from '../../../tests/fixtures/auth-email.js';
import { isNormalizedMailbox } from '../src/mailbox.js';
import { normalizeEmail } from '../src/service.js';

describe('cross-layer product mailbox grammar', () => {
  it('accepts every normalized service mailbox in the exact SMTP predicate', () => {
    let accepted = 0;
    let rejected = 0;
    for (const input of emailCorpus) {
      let normalized: string;
      try {
        normalized = normalizeEmail(input);
      } catch {
        rejected += 1;
        expect(isNormalizedMailbox(input)).toBe(false);
        continue;
      }
      accepted += 1;
      expect(isNormalizedMailbox(normalized)).toBe(true);
      expect(normalizeEmail(normalized)).toBe(normalized);
    }
    expect(accepted).toBeGreaterThan(15);
    expect(rejected).toBeGreaterThan(40);
  });
});
