import { beforeStartedPreview } from './started-preview-legacy.mjs';
// Exact reviewed additions peel off before all accepted predecessor checks.
import { createHash } from 'node:crypto';
const pins = {
  'scripts/test-database.mjs': {
    IMPORT: '18439cdf4250e3c5ffea0c8bb307ab9bac62bc0419fa44a7664c44a362d22d32',
    MIGRATION: '21a8ddfbaa343c75cb4d716e49995e08da1b7f3d0543a9f7f199214273b07f13',
    OWNER: '5859569a99ebebd4e0d9025b7f4d5d886b145abe096930338bfb0a85c88a82fe',
    UPGRADE: '87a1ea10e835be3c53c36e4c5b613b87b5279a2faf66bb56a71bdc00af14501d',
    OVERLAP: '4977f3367921107e3823d1c2925e90d2c71229bd51a4543a5a7feb8d4b8f9140',
    RESET_AFTER: '860993af7a853a205de56964a700cf3b76a9abfb227311f715a7e13f3bf8a0a3',
    POPULATED_RESET: '69d409ce1a929cf69ce9f0d7812531003c1a0ceff86b979827d4d2ba79610f0b',
    FLAGS: '2cc7dd5f0d3c97444481e1c1c56e9d88eb990ebbbb195c45e028ebb82bceb831',
    RESET_FRESH: 'fd77e2020e676555a6ef52af82ccd5c93b799ca67bdc0d4e7481e61faf613795',
  },
  'scripts/native-proof-artifacts.mjs': {
    REPORT: '91c0dd18a51528466614cb3744e8dc4a404d31dfa95ab59dab44cb2c6416edc7',
    DEADLINE: 'c62b7290ca26a1ad35d4c55801f4897c0b30084093b675fdfb6e6c5719edb5ad',
    EVIDENCE: '5133e3967da171b6bc8f9fb95fbf97842d240936d53ca099cf5f84f8e8a7017a',
  },
};
export function beforeStartedRisk(file, source) {
  source = beforeStartedPreview(file, source);
  const expected = pins[file];
  if (!expected || !source.includes('PAPER STARTED RISK')) return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PAPER STARTED RISK ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER STARTED RISK \1\n/gm,
    ),
  ];
  if (
    blocks.length !== Object.keys(expected).length ||
    (source.match(/PAPER STARTED RISK/gu) ?? []).length !== 2 * blocks.length ||
    blocks.some(
      (b, i) =>
        b[1] !== Object.keys(expected)[i] ||
        createHash('sha256').update(b[0]).digest('hex') !== expected[b[1]],
    )
  )
    throw Error('PAPER_STARTED_RISK_REVIEW_REQUIRED');
  for (const b of blocks) source = source.replace(b[0], '');
  return source;
}
