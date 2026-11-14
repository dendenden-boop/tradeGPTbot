import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  admissionConfigurationReview,
  beforeAdmissionConfiguration,
} from './admission-configuration-legacy.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const source = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');

it.each(Object.entries(admissionConfigurationReview))(
  'retains the complete published525 predecessor of %s beneath the single configuration setup',
  (file, review) => {
    const previous = beforeAdmissionConfiguration(file, source(file));
    expect(hash(previous)).toBe(review.predecessor);
    expect(beforeAdmissionConfiguration(file, previous)).toBe(previous);
    for (const patch of review.patches) expect(hash(patch.next)).toBe(patch.hash);
  },
);

it('rejects altered or duplicated setup and review blocks without concealing native changes', () => {
  for (const [file, review] of Object.entries(admissionConfigurationReview)) {
    const current = source(file);
    for (const patch of review.patches.filter((value) => value.tag)) {
      const boundary = patch.next.indexOf('\n') + 1;
      const changed =
        patch.next.slice(0, boundary) + '// unreviewed\n' + patch.next.slice(boundary);
      for (const candidate of [current + patch.next, current.replace(patch.next, changed)])
        expect(() => beforeAdmissionConfiguration(file, candidate)).toThrow(
          'ADMISSION_CONFIGURATION_REVIEW_REQUIRED',
        );
    }
  }
});
