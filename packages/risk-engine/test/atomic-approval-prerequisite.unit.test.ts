import { expect, it } from 'vitest';
import * as risk from '../src/index.js';

it('provides a physical production OrderRiskPort factory rather than a pure evaluation grant', () => {
  expect(risk).toHaveProperty('createPostgresOrderRiskPort');
  expect(Reflect.get(risk, 'createPostgresOrderRiskPort')).toBeTypeOf('function');
});
