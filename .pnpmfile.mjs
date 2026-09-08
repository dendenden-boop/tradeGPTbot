// Explicit build-time generation uses the directly pinned CLI and TypeScript.
// The compiled prisma-client generator output only imports client runtime modules.
// pnpm 11 normalizes leftover optional peer metadata back into '*' peer edges,
// so remove both metadata and the peer declarations for this exact client version.
export const hooks = {
  readPackage(manifest) {
    if (manifest.name === '@prisma/client' && manifest.version === '7.10.0') {
      for (const name of ['prisma', 'typescript']) {
        if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
          throw new Error('Expected an optional Prisma development peer');
        }
        delete manifest.peerDependencies?.[name];
        delete manifest.peerDependenciesMeta[name];
      }
    }
    return manifest;
  },
};
