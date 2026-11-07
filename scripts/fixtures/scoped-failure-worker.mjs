// Physical teardown fixture: fail only after the sibling and descendant exist.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [root, id] = process.argv.slice(2);
const owned = path.resolve('test-results/cohort-unit');
if (
  typeof root !== 'string' ||
  !path.resolve(root).startsWith(owned + path.sep) ||
  id !== 'native-admission'
)
  throw new Error('SCOPED_FAILURE_FIXTURE_REQUIRED');
writeFileSync(path.join(root, id + '.started'), String(process.pid));
while (
  !existsSync(path.join(root, 'admission.heartbeat')) ||
  !existsSync(path.join(root, 'descendant.heartbeat'))
)
  await delay(5);
process.exit(7);
