// Test-only reconstruction of the complete accepted main62 harness. Exact
// reviewed blocks prevent a new marker from concealing edits to old checks.
import { createHash } from 'node:crypto';
const pins = {
  'scripts/test-database.mjs': {
    IMPORT: '224bac97b5b1ea8f4344a5c7ab128d8ba0cbb8d23d6057f2b89b24da948513d2',
    OVERLAP_IMPORT: 'dd9883a229d7ae0b4682d84a2278dc0d0b2629dceaa95ef6c0775bfd80b5c43c',
    MIGRATION: '94f9645eba5b0abd68e0609e380c553997dab62787e8bf83920e5ee20a2e33e7',
    DB_NAME: 'df7b62414c1cbf997614f10656270373fb23559bffc56dbf5366b1fd7e696c08',
    OWNER: 'f4fd6832a2bdeb697a210ce2942683a0fecefb3ce511be9be37866a0a41ac450',
    UPGRADE: 'fc523721918f92e008d9e3dfd391c64a53cdd108aab8b102b98981bb622e6447',
    OVERLAP_SETUP: '4cc563cce5890ef3c817ebac13fafa3c0f200746b2f1a4644c29e1952faf7cd1',
    PLAN: '90bd741f3e878a99de954668b66f49c638c2445bea145deb0eea542c03ccbdbb',
    COHORT_ENV: '9f15aff9d6488733e33b0274eb82fc19b99dce85c6f192d06ff0d9a5cbee5fd0',
    ENV: 'dda7e75a143addabc9dea4cb7e485b35dd979353c26d0180370716fc764b7389',
    DATABASE: '51906f03cd3d30fa83a9c6e309d208a4c1cb4314ccdd9a6977df1e5544815fd3',
    RESET_AFTER: 'f70a9e907cc910bb51f9d50c286762220c9966115102789207ebcbff5320b313',
    POPULATED_RESET: 'fd5e12daccbb918861e1af5efa861c525cf3229838b32ff00772ffec18820548',
    FLAGS: '264997c078078a174700b67dff277f5ce37afeeee0c9ffdab1760b5f52acee17',
    RESET_FRESH: '0d4228b9a8605b2f9100eb3473a8de20c6559018880d56a538fa8e51872571f6',
  },
  'scripts/native-proof-artifacts.mjs': {
    REPORT: 'd998c282590118e2a074b4e319d1e67c91ad0b6193e15e4774445aaf6faa6a03',
    DEADLINE: '9c49f462009b5521fa95e88bfab7dcaf256a2d8f59705d2a40e5fe66bb45eadf',
    EVIDENCE: '36adbb672f70d9dbdce68949147c39c5af3d40a128ef00d3263cab9327ba65a4',
    LEGACY_PLAN: '70d0ca3eaa78d8156000301527804b6f72ffd6771b5c9eadad528b4e31d5fe3f',
  },
};
const original = {
  PLAN: '  const cohortPlan = planDatabaseCohorts(await discoverDatabaseFiles());\n',
  ENV: `      env:
        cohort.id === 'registry'
          ? registryEnv
          : cohort.id === 'admission'
            ? admissionEnv
            : nativeEnv,
`,
  DATABASE: `      database:
        cohort.id === 'registry'
          ? databases[5]
          : cohort.id === 'admission'
            ? databases[6]
            : databases[0],
`,
};
export function beforeExecutionStart(file, source) {
  const expected = pins[file];
  if (!expected || !source.includes('PAPER EXECUTION START')) return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PAPER EXECUTION START ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER EXECUTION START \1\n/gm,
    ),
  ];
  if (
    blocks.length !== Object.keys(expected).length ||
    (source.match(/PAPER EXECUTION START/gu) ?? []).length !== 2 * blocks.length ||
    blocks.some(
      (b, i) =>
        b[1] !== Object.keys(expected)[i] ||
        createHash('sha256').update(b[0]).digest('hex') !== expected[b[1]],
    )
  )
    throw Error('PAPER_EXECUTION_START_REVIEW_REQUIRED');
  for (const b of blocks) source = source.replace(b[0], original[b[1]] ?? '');
  return source;
}
