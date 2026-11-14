// Test-only exact accepted455 count review; no runtime authority or waiver.
import { createHash } from 'node:crypto';
export const currentRiskCountReview = {
  'scripts/native-proof-artifacts.mjs': {
    predecessor: '67b79c58f98ccd2d6b457ba499c9fe512ec21d7783461608d859ab3cf8cb7e54',
    current: 'dab04cff170a516967c93eeaad00041d6af9664dce8eef90e05febe25a48feba',
    patches: [
      {
        old: "  'paper-execution-commit': 35,\n",
        next: "  // BEGIN PAPER CURRENT RISK REPORT_COUNT\n  'paper-execution-commit': 36,\n  // END PAPER CURRENT RISK REPORT_COUNT\n",
      },
    ],
  },
  'scripts/test-database.mjs': {
    predecessor: '447f831f911cbdbd8924da9916de66b03f1e567ebe421e8fdf260026e4f73949',
    current: 'a6928ed2251b0b9523fabb25bcf830c48b3af03363eebc85e325a02b54e305ff',
    patches: [
      {
        old: '    assert.equal(executionCommitOwner.numPassedTests, 35);\n',
        next: '    // BEGIN PAPER CURRENT RISK OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 36);\n    // END PAPER CURRENT RISK OWNER_COUNT\n',
      },
      {
        old: '  assert.equal(executedValuationSeed.numPendingTests, 34);\n',
        next: '  // BEGIN PAPER CURRENT RISK PRE67_COUNT\n  assert.equal(executedValuationSeed.numPendingTests, 35);\n  // END PAPER CURRENT RISK PRE67_COUNT\n',
      },
    ],
  },
  'scripts/registry-domain-legacy.mjs': {
    predecessor: '0f657f56076f85661f4af375f43aa711b5a0b9c32e98cd0615b259603f967e2c',
    current: 'aa34daf655481f710e223b4b66a196646cda2261cfb06969a1d8aca2ecb89ee4',
    patches: [
      {
        old: '// Test-only exact307 reconstruction; no runtime authority or waiver.\n',
        next: "// PAPER CURRENT RISK COUNTS: exact36-case metadata peels before older reviews.\nimport { beforeCurrentRiskCounts } from './current-risk-count-legacy.mjs';\n// Test-only exact307 reconstruction; no runtime authority or waiver.\n",
      },
      {
        old: 'export function beforeRegistryDomain(file, source) {\n',
        next: 'export function beforeRegistryDomain(file, source) {\n  source = beforeCurrentRiskCounts(file, source);\n',
      },
    ],
  },
  'scripts/registry-domain-legacy.unit.test.mjs': {
    predecessor: '73c1bca48ac467103cb8501cbc7d45742de9ef868036824ab455431fe5301cfa',
    current: '3d10f0285c40de0378bd7ea75ad094c0d22f391348111f1306cb10aa51ade357',
    patches: [
      {
        old: "import { readFile } from 'node:fs/promises';\n",
        next: "// PAPER CURRENT RISK COUNTS: isolate older fixtures before their tamper checks.\nimport { beforeCurrentRiskCounts } from './current-risk-count-legacy.mjs';\nimport { readFile } from 'node:fs/promises';\n",
      },
      {
        old: "    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(\n      '\\r\\n',\n      '\\n',\n    );\n",
        next: "    const source = beforeCurrentRiskCounts(\n      file,\n      (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n'),\n    );\n",
      },
    ],
  },
};
export function beforeCurrentRiskCounts(file, source) {
  const review = currentRiskCountReview[file];
  if (!review || !source.includes('PAPER CURRENT RISK')) return source;
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  if (hash(source) !== review.current) throw Error('PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');
  for (const p of review.patches) {
    if (source.split(p.next).length !== 2) throw Error('PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');
    const at = source.indexOf(p.next);
    source = source.slice(0, at) + p.old + source.slice(at + p.next.length);
  }
  if (hash(source) !== review.predecessor) throw Error('PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');
  return source;
}
