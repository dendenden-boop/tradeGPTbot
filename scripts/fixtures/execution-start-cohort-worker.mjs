// Test-only physical child and dependency fixture. No financial/runtime access.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const [root, id, mode = 'normal'] = process.argv.slice(2);
const file = (name) => path.join(root, name);
writeFileSync(file(id + '.started'), String(process.pid));
const dependencies =
  id === 'execution-start'
    ? ['main', 'registry', 'admission', 'native-admission']
    : id === 'roles'
      ? ['main', 'registry', 'admission', 'native-admission', 'execution-start']
      : ['admission', 'native-admission'].includes(id)
        ? ['main', 'registry']
        : [];
for (const dependency of dependencies)
  if (readFileSync(file(dependency + '.done'), 'utf8') !== 'done') process.exit(8);
if (mode === 'fail') process.exit(7);
if (mode === 'tree')
  spawn(process.execPath, [import.meta.filename, root, 'descendant', 'hang'], {
    windowsHide: true,
    stdio: 'ignore',
  });
if (mode === 'hang' || mode === 'tree') {
  let sequence = 0;
  for (;;) {
    writeFileSync(file(id + '.heartbeat'), String(sequence++));
    await delay(10);
  }
}
await delay(30);
writeFileSync(file(id + '.done'), 'done');
