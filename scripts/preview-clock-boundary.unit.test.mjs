import fs from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { fixture, marketFixture } from '../packages/paper-engine/test/fixtures.js';
import { preparePaperFrame, evaluatePaperOrder } from '../packages/paper-engine/src/model.js';

const nativePath = 'packages/database/test/paper-started-preview.integration.test.ts';
async function actualNativeSampler() {
  const text = fs.readFileSync(new URL('../' + nativePath, import.meta.url), 'utf8');
  const file = ts.createSourceFile(
    nativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const test = file.statements.find(
    (n) =>
      ts.isExpressionStatement(n) &&
      ts.isCallExpression(n.expression) &&
      n.expression.arguments[0]?.text?.includes('fresh post-START public evidence'),
  );
  const body = test.expression.arguments[1].body.statements.find(ts.isTryStatement).tryBlock
    .statements;
  const declares = (statement, name) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((d) => d.name.getText(file) === name);
  const start = body.findIndex((n) => declares(n, 'eligible')),
    end = body.findIndex((n) => declares(n, 'snapshotHead'));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const block = body
    .slice(start, end)
    .map((n) => n.getText(file))
    .join('\n');
  const { outputText } = ts.transpileModule(
    'export function bind(Date,delay,waitForFixtureClock) { return async (receipt,f) => {' +
      block +
      '\nreturn {eligible,now};};}',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  );
  const { bind } = await import(
    'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
  );
  return bind;
}
async function earlyWakeSample() {
  const f = fixture(),
    startedAt = f.execution.submittedAt,
    eligible = startedAt + f.model.latencyMs + f.model.latencyJitterMs;
  let now = startedAt;
  const clock = { now: () => now };
  const pause = async (ms) => {
    now = Math.max(now + 1, Math.min(eligible, now + ms - 1));
  };
  const bind = await actualNativeSampler();
  const sample = await bind(
    clock,
    pause,
    undefined,
  )({ startedAt }, { c: { model: f.model }, f: { s: {}, p: {} } });
  return { ...sample, f };
}

it('actual native preview preparation rechecks the clock after an early timer wakeup before timestamping evidence', async () => {
  const sampled = await earlyWakeSample();
  expect(sampled.now).toBeGreaterThanOrEqual(sampled.eligible);
});
it('actual native early-wakeup path must produce genuine post-latency evidence for the existing positive-fill assertion', async () => {
  const { now, eligible, f } = await earlyWakeSample(),
    evaluationAt = eligible + 20;
  const frame = preparePaperFrame({
    ...marketFixture(),
    now: evaluationAt,
    book: { ...f.book, receivedAt: now, exchangeTime: now },
    trade: { ...f.trade, receivedAt: now, exchangeTime: now },
  });
  const result = evaluatePaperOrder({ ...f.execution, now: evaluationAt, frame });
  expect(
    result.fills.length,
    JSON.stringify({
      reason: result.reason,
      evidenceAt: now,
      eligibleAfter: result.eligibleAfter,
      evaluationAt,
    }),
  ).toBeGreaterThan(0);
});
