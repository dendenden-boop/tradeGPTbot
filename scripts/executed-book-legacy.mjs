// Test-only exact B15 reconstruction beneath reviewed capture owner counts.
import { createHash } from 'node:crypto';
export const executedBookReview = {
  'scripts/test-database.mjs': {
    predecessor: '4868e3962a665a23efa3f63a9e01839373b8f98e26d427c8643ae09af10e3ccc',
    patches: [
      {
        tag: 'OWNER_COUNT',
        old: '    assert.equal(executionCommitOwner.numPassedTests, 13);\n',
        next: '    // BEGIN PAPER EXECUTED BOOK OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 20);\n    // END PAPER EXECUTED BOOK OWNER_COUNT\n',
        hash: '55fa1a230627ed3a85e46a29a4647712f97a2f5b79a5205c72f095d9b083562f',
      },
    ],
  },
  'scripts/native-proof-artifacts.mjs': {
    predecessor: '21ea374223ade2cf2467c1928e3835f6e69db5b7a65fe1a4bb65833acaf32b8d',
    patches: [
      {
        tag: 'REPORT_COUNT',
        old: "  'paper-execution-commit': 13,\n",
        next: "  // BEGIN PAPER EXECUTED BOOK REPORT_COUNT\n  'paper-execution-commit': 20,\n  // END PAPER EXECUTED BOOK REPORT_COUNT\n",
        hash: '9d9d4d8bb5577af8ce7c528a12959aa8be123386617161064e7b5ca66aa1abfb',
      },
    ],
  },
  'scripts/certified-cluster-legacy.mjs': {
    predecessor: 'ce821ea884ccc3ff433aa6e91dd5477549d45e8de0ea5fba41a00843a67ddd79',
    patches: [
      {
        tag: 'LEGACY_IMPORT',
        old: '',
        next: "// BEGIN PAPER EXECUTED BOOK LEGACY_IMPORT\nimport { beforeExecutedBookCapture } from './executed-book-legacy.mjs';\n// END PAPER EXECUTED BOOK LEGACY_IMPORT\n",
        hash: '429762160896596605861b86caa9df749712a09c299953e4ef693f62866d148b',
      },
      {
        tag: 'LEGACY_RESTORE',
        old: '',
        next: "  // BEGIN PAPER EXECUTED BOOK LEGACY_RESTORE\n  try {\n    source = beforeExecutedBookCapture(file, source);\n  } catch {\n    throw Error('ROLE_SCOPED_REVIEW_REQUIRED');\n  }\n  // END PAPER EXECUTED BOOK LEGACY_RESTORE\n",
        hash: '0dee2312618e05a84a616d3fe294a41e715765c2f681f64b6a2c320392a5d91a',
      },
    ],
  },
};
export function beforeExecutedBookCapture(file, source) {
  const review = executedBookReview[file];
  if (!review || !source.includes('PAPER EXECUTED BOOK')) return source;
  if (
    (source.match(/BEGIN PAPER EXECUTED BOOK /gu) ?? []).length !== review.patches.length ||
    (source.match(/END PAPER EXECUTED BOOK /gu) ?? []).length !== review.patches.length
  )
    throw Error('PAPER_EXECUTED_BOOK_REVIEW_REQUIRED');
  for (const patch of review.patches) {
    if (
      source.split(patch.next).length !== 2 ||
      createHash('sha256').update(patch.next).digest('hex') !== patch.hash
    )
      throw Error('PAPER_EXECUTED_BOOK_REVIEW_REQUIRED');
    source = source.replace(patch.next, patch.old);
  }
  return source;
}
