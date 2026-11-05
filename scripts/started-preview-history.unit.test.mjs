import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeStartedPreview } from './started-preview-legacy.mjs';
const pins = {
  'scripts/test-database.mjs': 'd8459ad338b1ba60eb0200eb225314370c3367cf2521cfa21ee8a81f8d72c38c',
  'scripts/native-proof-artifacts.mjs':
    '0cb959b58d01955f1b0b70d3dc8a0e49782b2fafc7ca4126bc8e0bb5377deda8',
  'scripts/started-source-harness.unit.test.mjs':
    '5cc92ad159aab23edef0536cf2561a4ccb6c0aace969e2612c57272d7a63de79',
  'scripts/started-risk-harness.unit.test.mjs':
    'ddae50ebf79e0196f4704282b977b2735c0dc3716c31b2d480da205283533428',
};
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
it.each(Object.entries(pins))(
  'preserves every accepted faff84f harness statement outside exact preview additions in %s',
  (file, expected) => {
    const source = read(file),
      clean = beforeStartedPreview(file, source);
    expect(createHash('sha256').update(clean).digest('hex')).toBe(expected);
    expect(beforeStartedPreview(file, clean)).toBe(clean);
    const block = source.match(
      /^[ \t]*\/\/ BEGIN PAPER STARTED PREVIEW ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER STARTED PREVIEW \1\n/mu,
    )[0];
    const insertion = block.indexOf('\n') + 1;
    const changed = block.slice(0, insertion) + '// unreviewed\n' + block.slice(insertion);
    for (const corrupt of [
      source + block,
      source.replace(block, changed),
      source.replace('END PAPER STARTED PREVIEW', 'END CHANGED PREVIEW'),
    ])
      expect(() => beforeStartedPreview(file, corrupt)).toThrow(
        'PAPER_STARTED_PREVIEW_REVIEW_REQUIRED',
      );
  },
);

const predecessors = {
  'scripts/started-risk-preservation.unit.test.mjs':
    '78242449bb0d56a9085efef209578925f7fa3c31e0aeebef64c777ee0cc287d1',
  'scripts/started-risk-legacy.mjs':
    'ed1409e0da30020c05797785e478571465978ad313e89c72ac0b0c3706f26467',
};
it.each(Object.entries(predecessors))(
  'retains every original predecessor proof statement beneath the explicit new normalization layer in %s',
  (file, expected) => {
    let source = read(file).replace(
      "import { beforeStartedPreview } from './started-preview-legacy.mjs';\n",
      '',
    );
    if (file.endsWith('started-risk-legacy.mjs'))
      source = source.replace('  source = beforeStartedPreview(file, source);\n', '');
    else
      source = source
        .replace('const rawRead = (p) =>', 'const read = (p) =>')
        .replace('const read = (p) => beforeStartedPreview(p, rawRead(p));\n', '');
    expect(createHash('sha256').update(source).digest('hex')).toBe(expected);
  },
);
