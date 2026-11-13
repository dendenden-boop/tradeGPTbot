// Test-only prefix work. Actual processes, dependencies and 30ms work remain;
// these non-spawning stages need only file IO, not the tree worker's ESM graph.
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const [root, id] = process.argv.slice(2);
if (!['main', 'registry', 'admission', 'native-admission'].includes(id)) process.exit(8);
const file = (name) => path.join(root, name);
writeFileSync(file(id + '.started'), String(process.pid));
if (['admission', 'native-admission'].includes(id))
  for (const dependency of ['main', 'registry'])
    if (readFileSync(file(dependency + '.done'), 'utf8') !== 'done') process.exit(8);
setTimeout(() => writeFileSync(file(id + '.done'), 'done'), 30);
