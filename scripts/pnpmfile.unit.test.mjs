import { describe, expect, it } from 'vitest';
import { hooks } from '../.pnpmfile.mjs';

describe('production Prisma dependency normalization', () => {
  it('is idempotent when pnpm revisits an already normalized manifest', () => {
    const manifest = {
      name: '@prisma/client',
      version: '7.10.0',
      peerDependencies: { prisma: '*', typescript: '>=5', unrelated: '1' },
      peerDependenciesMeta: { prisma: { optional: true }, typescript: { optional: true } },
    };
    hooks.readPackage(manifest);
    expect(hooks.readPackage(manifest)).toEqual({
      name: '@prisma/client',
      version: '7.10.0',
      peerDependencies: { unrelated: '1' },
      peerDependenciesMeta: {},
    });
  });
  it('refuses to remove required or unexpectedly normalized peer edges', () => {
    expect(() =>
      hooks.readPackage({
        name: '@prisma/client',
        version: '7.10.0',
        peerDependencies: { prisma: '*' },
      }),
    ).toThrow('Expected an optional Prisma development peer');
  });
});
