// Test-only physical scheduler probe; no database or network access.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const [root, id, mode = 'normal'] = process.argv.slice(2),
  file = (name) => path.join(root, name);
writeFileSync(file(id + '.started'), String(process.pid));
const dependencies =
  id === 'registry'
    ? []
    : ['main', 'main-scoped'].includes(id)
      ? ['registry']
      : ['admission', 'native-admission', 'execution-start'].includes(id)
        ? ['registry', 'main-scoped']
        : id === 'execution-preview'
          ? ['execution-start']
          : id === 'execution-commit'
            ? [
                'main',
                'registry',
                'main-scoped',
                'admission',
                'native-admission',
                'execution-start',
                'execution-preview',
              ]
            : id === 'roles'
              ? [
                  'main',
                  'registry',
                  'main-scoped',
                  'admission',
                  'native-admission',
                  'execution-start',
                  'execution-preview',
                  'execution-commit',
                ]
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
  while (!existsSync(file('main.heartbeat'))) await delay(5);
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
