import { expect, it } from 'vitest';
import * as risk from '../src/index.js';

it('provides a physical PostgreSQL snapshot store instead of a reference default', () => {
  expect(risk).toHaveProperty('createPostgresRiskSnapshotStore');
  expect(typeof Reflect.get(risk, 'createPostgresRiskSnapshotStore')).toBe('function');
});
