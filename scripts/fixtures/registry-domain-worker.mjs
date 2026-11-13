// Physical process probe only; no PostgreSQL, credentials or financial state.
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const [root, id, mode = 'controlled'] = process.argv.slice(2);
if (!['registry', 'native-admission'].includes(id)) {
  await import('./cluster-isolated-worker.mjs');
} else {
  const file = (name) => path.join(root, name);
  writeFileSync(file(id + '.started'), String(process.pid));
  if (mode === 'tree')
    spawn(process.execPath, [import.meta.filename, root, 'descendant', 'hang'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  let sequence = 0;
  for (;;) {
    writeFileSync(file(id + '.heartbeat'), String(sequence++));
    if (
      mode === 'fail' &&
      existsSync(file((id === 'registry' ? 'native-admission' : 'registry') + '.heartbeat')) &&
      existsSync(file('descendant.heartbeat'))
    )
      process.exit(7);
    if (mode === 'controlled' && existsSync(file(id + '.release'))) break;
    await delay(5);
  }
  writeFileSync(file(id + '.done'), 'done');
}
