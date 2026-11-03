// Test-only physical scheduling probe; no database, role DDL or runtime access.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const [root, id, mode = 'normal'] = process.argv.slice(2),
  file = (name) => path.join(root, name);
writeFileSync(file(id + '.started'), String(process.pid));
const initial = ['main', 'registry'];
const dependencies = ['admission', 'native-admission'].includes(id)
  ? initial
  : id === 'execution-start'
    ? initial
    : id === 'roles'
      ? [...initial, 'admission', 'native-admission', 'execution-start']
      : [];
for (const dependency of dependencies)
  if (readFileSync(file(dependency + '.done'), 'utf8') !== 'done') process.exit(8);
if (
  id === 'execution-start' &&
  !existsSync(file('admission.done')) &&
  !existsSync(file('native-admission.done'))
)
  process.exit(8);
if (mode === 'fail') {
  while (!existsSync(file('admission.heartbeat'))) await delay(5);
  process.exit(7);
}
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
if (mode === 'controlled') while (!existsSync(file(id + '.release'))) await delay(5);
await delay(30);
writeFileSync(file(id + '.done'), 'done');
