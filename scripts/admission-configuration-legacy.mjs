// Private exact review of one redundant fixture registration; never runtime authority.
import { createHash } from 'node:crypto';
export const admissionConfigurationReview = {
  'packages/database/test/paper-admission.integration.test.ts': {
    predecessor: '9e27194b1d8bf053090f6621098a663d03aa06c55b074133d15618a3ea566c87',
    patches: [
      {
        tag: 'SINGLE CONFIGURATION SETUP',
        old: '  const f = await fixture();\n',
        next: '  // BEGIN SINGLE CONFIGURATION SETUP\n  // fundCash registers this configuration through the actual authority before funding.\n  const f = await fixture({ configure: false });\n  // END SINGLE CONFIGURATION SETUP\n',
        hash: '5300c5a466e45a847c93ed54c293dd88d1c75a897c307356a4a11a0b0bb4d34c',
      },
    ],
  },
  'scripts/database-cohorts.mjs': {
    predecessor: 'fbf66064eeab2b57c359ae06241b49f0bf33fee853412970b36568aab51744f4',
    patches: [
      {
        tag: null,
        old: "[admission, '9e27194b1d8bf053090f6621098a663d03aa06c55b074133d15618a3ea566c87']",
        next: "[admission, '27ab665e12d17d0422766c51e019377e152b6516dfc3440334d87e315763a453']",
        hash: 'dab50f59361ebccb47dca1acf851c7d85e509ee98a42b039055e47c2565290e1',
      },
    ],
  },
  'scripts/admission-funding-lane-legacy.mjs': {
    predecessor: '00929bca0a9d5fa5328bdec73cc3aa96dce05ab4cb4b0ad916a7572f8a7afb2e',
    patches: [
      {
        tag: 'SINGLE CONFIGURATION REVIEW_IMPORT',
        old: '',
        next: "// BEGIN SINGLE CONFIGURATION REVIEW_IMPORT\nimport { beforeAdmissionConfiguration } from './admission-configuration-legacy.mjs';\n// END SINGLE CONFIGURATION REVIEW_IMPORT\n",
        hash: 'fed849a15eccbfafc5399dce8434ccc41d16e1b8a0f412497d769007ce06f806',
      },
      {
        tag: 'SINGLE CONFIGURATION REVIEW_RESTORE',
        old: '',
        next: "  // BEGIN SINGLE CONFIGURATION REVIEW_RESTORE\n  try {\n    source = beforeAdmissionConfiguration(file, source);\n  } catch {\n    throw Error('ADMISSION_FUNDING_REVIEW_REQUIRED');\n  }\n  // END SINGLE CONFIGURATION REVIEW_RESTORE\n",
        hash: '5fb1e62bb5e92878fc5028447d9633cb16d82f5b3f05af7b4c48b550fac2afa6',
      },
    ],
  },
  'scripts/risk-seed-setup.unit.test.mjs': {
    predecessor: '3f43f5fd4a370f7eb74b7a77ff9583aac51a1448169c5d04c71f4ef7ada0b1d9',
    patches: [
      {
        tag: 'SINGLE CONFIGURATION SEED_IMPORT',
        old: '',
        next: "// BEGIN SINGLE CONFIGURATION SEED_IMPORT\nimport { beforeAdmissionConfiguration } from './admission-configuration-legacy.mjs';\n// END SINGLE CONFIGURATION SEED_IMPORT\n",
        hash: '88ae4ab763780de4ec7a5c3a58948bee6f42f9c82e9d993477ca0a56220d6299',
      },
      {
        tag: 'SINGLE CONFIGURATION SEED_RESTORE',
        old: '    const previous = beforeRiskSeedSetup(path, current);\n',
        next: '    // BEGIN SINGLE CONFIGURATION SEED_RESTORE\n    const previous = beforeRiskSeedSetup(path, beforeAdmissionConfiguration(path, current));\n    // END SINGLE CONFIGURATION SEED_RESTORE\n',
        hash: 'd90e2f3862cf833badb423a601a717cb7cb70b15b14f6c9d8dfa709a48601024',
      },
    ],
  },
};
export function beforeAdmissionConfiguration(file, source) {
  const review = admissionConfigurationReview[file];
  if (!review) return source;
  const active = review.patches.some((p) =>
    p.tag ? source.includes(p.tag) : source.includes(p.next),
  );
  if (!active) return source;
  for (const p of review.patches) {
    if (
      createHash('sha256').update(p.next).digest('hex') !== p.hash ||
      source.split(p.next).length !== 2 ||
      (p.tag && source.split(p.tag).length !== 3)
    )
      throw Error('ADMISSION_CONFIGURATION_REVIEW_REQUIRED');
    source = source.replace(p.next, p.old);
  }
  return source;
}
