import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Test the actual Vitest -> mocker dependency, not a separately installed copy.
// GHSA-qxg6-89mg-rqv8 / GHSA-xp26-3454-mjgp; generated text is parsed, never run.
const rootRequire = createRequire(import.meta.url);
const vitestRequire = createRequire(rootRequire.resolve('vitest/package.json'));
const { createManualModuleSource, interceptorPlugin } = await import(
  pathToFileURL(vitestRequire.resolve('@vitest/mocker/node')).href
);

it.each([
  '/synthetic-module.js',
  'x"); globalThis.SYNTHETIC_MOCKER_CANARY = 1; void("',
  'synthetic\nmodule"\\name.js',
])('installed manual mock keeps %j as one literal URL without injected statements', (url) => {
  const code = createManualModuleSource(url, ['value']);
  const parsed = ts.createSourceFile(
    'synthetic.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  expect(parsed.parseDiagnostics).toHaveLength(0);
  const calls = [];
  const walk = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getFactoryModule'
    )
      calls.push(node);
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  expect(calls).toHaveLength(1);
  expect(calls[0].arguments).toHaveLength(1);
  expect(ts.isStringLiteral(calls[0].arguments[0])).toBe(true);
  expect(calls[0].arguments[0].text).toBe(url);
});

it.each([
  ['traversal:./inside.js', 'C:/fixture/root/inside.js'],
  ['traversal:..\\synthetic.js', 'C:/fixture/synthetic.js'],
])('installed redirect hook normalizes %s before the file allowlist', (redirect, expected) => {
  const registrations = [],
    listeners = new Map();
  const plugin = interceptorPlugin({
    registry: { register: (event) => registrations.push({ ...event }) },
  });
  // Only observe the path delivered to the registry; this fixture reads no
  // files, starts no server and makes no network calls. Disabling the fixture
  // allowlist makes normalization observable identically on both host OSes.
  // Production/Vite defaults and their strict allowlist are unchanged.
  plugin.configureServer({
    config: { root: 'C:/fixture/root', server: { fs: { strict: false } } },
    ws: { on: (name, listener) => listeners.set(name, listener), send: () => {} },
  });
  expect(listeners.get('vitest:interceptor:register')).toBeTypeOf('function');
  listeners.get('vitest:interceptor:register')({
    type: 'redirect',
    raw: '',
    id: 'synthetic',
    url: 'synthetic',
    redirect,
  });
  expect(registrations).toHaveLength(1);
  expect(registrations[0].redirect).toBe(expected);
  expect(registrations[0].redirect).not.toContain('\\');
});
