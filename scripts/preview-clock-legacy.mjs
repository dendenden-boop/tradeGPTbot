// Exact test-only reconstruction of the b4e200a native fixture and scheduling guard.
import { createHash } from 'node:crypto';
import { beforeExecutionCommit } from './execution-commit-legacy.mjs';
const pins = {
  'packages/database/test/paper-started-preview.integration.test.ts': [
    [
      'IMPORT',
      'e635e53b2bc793741b1481477b174b34f22870bf20252d92c295274496e8ca9c',
      "import { setTimeout as delay } from 'node:timers/promises';\n",
    ],
    [
      'WAIT',
      '4200d7c8a3a2e8a8e463307815638e556f5fdbc48dad92b08ddb9142956723f9',
      '    const wait = eligible - Date.now();\n    if (wait > 0) await delay(wait);\n    const now = Date.now(),\n      snapshot = structuredClone(f.f.s),\n      trade = structuredClone(f.f.p);\n',
    ],
    [
      'ASSERTION',
      'cf56aec053566c1239627e63edc836228eb658aca39ac6992abca7636107590c',
      '      expect(r.execution.calculation.fills.length).toBeGreaterThan(0);\n',
    ],
  ],
  'scripts/database-cohorts.mjs': [
    [
      'FINGERPRINT',
      '8b8559cb4f002a60d377a6325183dd983f1208f263fc1fd219b66ddc4fe8d54e',
      "export async function verifyStartedPreviewParallelFiles(root = workspace) {\n  const source = (await readFile(path.join(root, startedPreview), 'utf8')).replaceAll('\\r\\n', '\\n');\n  assert.equal(\n    createHash('sha256').update(source).digest('hex'),\n    '9c9345814b8566120678ea887743078c5f02416fa5a80d5a17082212efbc63d1',\n    'Started-preview overlap requires renewed cluster-role review',\n  );\n  assert(\n    !/\\b(?:CREATE|ALTER|DROP)\\s+(?:ROLE|DATABASE)\\b|\\bGRANT\\s|\\bREVOKE\\s/iu.test(source),\n    'Started-preview overlap cannot mutate cluster roles',\n  );\n}\n",
    ],
  ],
};
export function beforePreviewClock(file, source) {
  source = beforeExecutionCommit(file, source);
  const expected = pins[file];
  if (!expected || !source.includes('PREVIEW CLOCK FIXTURE')) return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PREVIEW CLOCK FIXTURE ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PREVIEW CLOCK FIXTURE \1\n/gm,
    ),
  ];
  if (
    blocks.length !== expected.length ||
    (source.match(/PREVIEW CLOCK FIXTURE/gu) ?? []).length !== expected.length * 2
  )
    throw Error('PREVIEW_CLOCK_REVIEW_REQUIRED');
  for (const [index, block] of blocks.entries()) {
    const [tag, hash, original] = expected[index];
    if (block[1] !== tag || createHash('sha256').update(block[0]).digest('hex') !== hash)
      throw Error('PREVIEW_CLOCK_REVIEW_REQUIRED');
    source = source.replace(block[0], original);
  }
  if (source.includes('PREVIEW CLOCK FIXTURE')) throw Error('PREVIEW_CLOCK_REVIEW_REQUIRED');
  return source;
}
