// Test-only owned process fixture. Never imported by production/deployment code.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [root, id, mode, wait = '0'] = process.argv.slice(2);
const file = (name) => path.join(root, name);
writeFileSync(file(`${id}.started`), String(process.pid));
if (mode === 'tree') {
  const child = spawn(process.execPath, [import.meta.filename, root, 'descendant', 'hang'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  writeFileSync(file('descendant.pid'), String(child.pid));
}
if (mode === 'parallel' || mode === 'fail') {
  const peer = id === 'main' ? 'registry' : 'main';
  while (!existsSync(file(`${peer}.${mode === 'fail' ? 'heartbeat' : 'started'}`))) await delay(5);
}
if (mode === 'serial') {
  for (const dependency of ['main', 'registry']) {
    if (readFileSync(file(`${dependency}.done`), 'utf8') !== 'done') process.exit(8);
  }
}
if (mode === 'fail') process.exit(7);
if (mode === 'hang' || mode === 'tree') {
  let sequence = 0;
  for (;;) {
    writeFileSync(file(`${id}.heartbeat`), String(sequence++));
    await delay(10);
  }
}
await delay(Number(wait));
writeFileSync(file(`${id}.done`), 'done');
