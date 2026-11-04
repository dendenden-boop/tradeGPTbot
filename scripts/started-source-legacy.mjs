// Exact reviewed additions peel off before the older accepted harness checks.
import { createHash } from 'node:crypto';
import { beforeStartedRisk } from './started-risk-legacy.mjs';
const pins = {
  'scripts/test-database.mjs': {
    IMPORT: 'f3a137fb6a146abbc41167c397ee9ff1cba67d5e25f339d5f6bda66326a0926b',
    MIGRATION: 'a595926a78b4740dd31ccb86a4ab537c59db3db4c2dcd4885c22d2ec8102108d',
    OWNER: '1b8843402bf55931a15e258a3b2ea16782fb6aa3911721e235cca338ffb5ff23',
    UPGRADE: 'fb142215ad7ac0dc5183e353f1d3ea4ea1d69802ec463959c624d7c7bba7daed',
    OVERLAP: '19e34cab1b07812c542fe0f812f54533230e32626a466e824e833f0f77d507e9',
    RESET_AFTER: '29f2882ac255d1d71034a2717dec8402327ad986fbccb0270f3f235892d4e489',
    POPULATED_RESET: '6d0289c3ef0c58127d040ae5c371bb08fbded37fb8ce3305789dc357dea3e4c4',
    FLAGS: 'e42702d7c62995c1f8396a8c6b3c1aeb98e2831c8a9884c5097fec3eb0080e29',
    RESET_FRESH: 'a35dd2e5ce45bcf3132622de03105de5dd15e0283214295ab2837497c79ec06e',
  },
  'scripts/native-proof-artifacts.mjs': {
    REPORT: 'a0500af3cf3e7e468746f03622baf5a9398fc5911d2b4e049ffc0764ac17e56f',
    DEADLINE: '185151f0f724f20d108ac4b65a7eacde9f743fc00c263c8f2980583d3a163a82',
    EVIDENCE: 'e6a28335c44ca49feec56003120b5daccb835a77b2160834b1609b5ac8926ec6',
  },
};
export function beforeStartedSource(file, source) {
  source = beforeStartedRisk(file, source);
  const expected = pins[file];
  if (!expected || !source.includes('PAPER STARTED SOURCE')) return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PAPER STARTED SOURCE ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER STARTED SOURCE \1\n/gm,
    ),
  ];
  if (
    blocks.length !== Object.keys(expected).length ||
    (source.match(/PAPER STARTED SOURCE/gu) ?? []).length !== 2 * blocks.length ||
    blocks.some(
      (b, i) =>
        b[1] !== Object.keys(expected)[i] ||
        createHash('sha256').update(b[0]).digest('hex') !== expected[b[1]],
    )
  )
    throw Error('PAPER_STARTED_SOURCE_REVIEW_REQUIRED');
  for (const b of blocks) source = source.replace(b[0], '');
  return source;
}
