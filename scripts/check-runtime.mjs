const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 20) {
  console.error(
    'Node.js 24.20.0 or a newer Node.js 24 security patch is required. See .node-version.',
  );
  process.exitCode = 1;
}
