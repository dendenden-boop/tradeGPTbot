import { expect, it } from 'vitest';
import { paperRuntimePublicationSchema } from '../src/runtime-domain.js';
import { runtimeFixture } from './runtime-fixtures.js';

it('rejects a noncanonical digest with a trailing newline before database I/O', () => {
  const f = runtimeFixture();
  f.publication.observation.configurationHash += String.fromCharCode(10);
  expect(paperRuntimePublicationSchema.safeParse(f.publication).success).toBe(false);
});
