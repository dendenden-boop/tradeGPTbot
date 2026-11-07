import fs from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as scope from './native-main-scopes.mjs';

async function moduleFrom(body) {
  const { outputText } = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
async function actualDatabaseName(suffix) {
  const file = ts.createSourceFile(
    'runner.mjs',
    fs.readFileSync('scripts/test-database.mjs', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = file.statements.find(
    (s) =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some((d) => d.name.getText(file) === 'databases'),
  );
  const { names } = await moduleFrom(
    'export function names(suffix,scopedMainDatabaseName) {' +
      declaration.getText(file) +
      ';return databases;}',
  );
  return names(suffix, scope.scopedMainDatabaseName)[8];
}
async function actualGuard(name) {
  const file = ts.createSourceFile(
    name,
    fs.readFileSync(name, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const end = file.statements.findIndex(
    (s) =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some((d) => d.name.getText(file) === 'admin'),
  );
  const prefix = file.statements
    .slice(0, end)
    .filter((s) => !ts.isImportDeclaration(s))
    .map((s) => s.getText(file))
    .join('\n');
  return (
    await moduleFrom('export function guard(process) {' + prefix + ';return isolated.pathname;}')
  ).guard;
}
it.each(['paper-reservation-state', 'paper-reservation-storage'])(
  'the actual runner database passes the unchanged %s native isolation guard before PostgreSQL I/O',
  async (name) => {
    const database = await actualDatabaseName('aabbcc112233');
    const guard = await actualGuard('packages/database/test/' + name + '.integration.test.ts');
    const process = {
      env: {
        NODE_ENV: 'test',
        CTP_TEST_PROJECT: 'ctp-integration-123-0123456789ab',
        DATABASE_MIGRATION_URL: 'postgresql://127.0.0.1:5432/' + database,
      },
    };
    expect(() => guard(process)).not.toThrow();
    expect(database).not.toBe('ctp_p2_fresh_aabbcc112233');
    expect(guard(process)).toBe('/' + database);
  },
);
it('retains twelve exact hexadecimal digits and a distinct reversible owned sibling for every boundary nibble', () => {
  expect(typeof scope.scopedMainDatabaseName).toBe('function');
  for (const nibble of '0123456789abcdef') {
    const main = 'ctp_p2_fresh_00000000000' + nibble;
    const sibling = scope.scopedMainDatabaseName(main);
    expect(sibling).toMatch(/^ctp_p2_fresh_[a-f0-9]{12}$/);
    expect(sibling).not.toBe(main);
    expect(scope.scopedMainDatabaseName(sibling)).toBe(main);
  }
  expect(scope.scopedMainDatabaseName('ctp_p2_fresh_ffffffffffff')).toBe(
    'ctp_p2_fresh_fffffffffffe',
  );
});
it.each([
  'production',
  'ctp_p2_fresh_aa',
  'ctp_p2_fresh_aabbcc11223300',
  'ctp_p2_owner_aabbcc112233',
  'ctp_p2_fresh_../../secret',
  'ctp_p2_fresh_AABBCC112233',
])('rejects foreign or malformed parent %s before deriving a disposable database', (name) => {
  expect(() => scope.scopedMainDatabaseName(name)).toThrow('NATIVE_SCOPED_DATABASE_NAME');
});
