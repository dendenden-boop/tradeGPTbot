// Test-only physical process fixture for the bounded fourth native cohort.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [root, id, mode = 'normal'] = process.argv.slice(2);
const file = (name) => path.join(root, name);
writeFileSync(file(id + '.started'), String(process.pid));
if (id === 'registry') while (!existsSync(file('main.started'))) await delay(5);
if (id === 'admission' && !existsSync(file('registry.done'))) process.exit(8);
if (id === 'roles')
  for (const dependency of ['main', 'registry', 'admission'])
    if (readFileSync(file(dependency + '.done'), 'utf8') !== 'done') process.exit(9);
if (mode === 'fail') process.exit(7);
if (mode === 'tree') {
  spawn(process.execPath, [import.meta.filename, root, 'descendant', 'hang'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}
if (mode === 'hang' || mode === 'tree') {
  let sequence = 0;
  for (;;) {
    writeFileSync(file(id + '.heartbeat'), String(sequence++));
    await delay(10);
  }
}
if (id === 'main') while (!existsSync(file('admission.started'))) await delay(5);
await delay(30);
writeFileSync(file(id + '.done'), 'done');
