import { expect, it } from 'vitest';
import * as runtime from '../src/runtime.js';
import * as pure from '../src/index.js';

it.each(['createPostgresPaperRuntimeObservations', 'createPostgresPaperRuntimeSource'])(
  'provides the separate server-owned %s authority without exposing it from the pure root',
  (name) => {
    expect((runtime as Record<string, unknown>)[name], 'PAPER_RUNTIME_FACTORY_MISSING').toBeTypeOf(
      'function',
    );
    expect(name in pure).toBe(false);
    expect('approve' in runtime).toBe(false);
  },
);
