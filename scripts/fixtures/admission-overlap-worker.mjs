// Physical acceptance fixture only; no database or financial runtime access.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
const [root, id, mode = 'normal'] = process.argv.slice(2);
const file = (name) => path.join(root, name);
writeFileSync(file(id + '.started'), String(process.pid));
if (['admission', 'native-admission'].includes(id))
  for (const dependency of ['main', 'registry'])
    if (readFileSync(file(dependency + '.done'), 'utf8') !== 'done') process.exit(8);
if (id === 'roles')
  for (const dependency of ['main', 'registry', 'admission', 'native-admission'])
    if (readFileSync(file(dependency + '.done'), 'utf8') !== 'done') process.exit(9);
if (mode === 'fail') {
  const peer = id === 'admission' ? 'native-admission' : 'admission';
  while (!existsSync(file(peer + '.heartbeat'))) await wait(5);
  process.exit(7);
}
if (mode === 'tree')
  spawn(process.execPath, [import.meta.filename, root, 'descendant', 'hang'], {
    windowsHide: true,
    stdio: 'ignore',
  });
if (mode === 'hang' || mode === 'tree') {
  let revision = 0;
  for (;;) {
    writeFileSync(file(id + '.heartbeat'), String(revision++));
    await wait(10);
  }
}
if (mode === 'controlled') while (!existsSync(file(id + '.release'))) await wait(5);
await wait(mode === 'cost' ? 1700 : 30);
writeFileSync(file(id + '.done'), 'done');
