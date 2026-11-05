import fs from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { fixture, marketFixture } from '../packages/paper-engine/test/fixtures.js';
import { preparePaperFrame, evaluatePaperOrder } from '../packages/paper-engine/src/model.js';

const nativePath = 'packages/database/test/paper-started-preview.integration.test.ts';
async function clockFactory() {
  const file = new URL('../packages/database/test/fixtures/preview-clock.ts', import.meta.url);
  if (!fs.existsSync(file)) throw Error('PREVIEW_FIXTURE_CLOCK_MISSING');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')))
    .waitForFixtureClock;
}
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
    'export function bind(Date,delay,waitForFixtureClock,startIo) { return async (receipt,f) => {' +
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
  const available = fs.existsSync(
    new URL('../packages/database/test/fixtures/preview-clock.ts', import.meta.url),
  );
  const wait = available ? await clockFactory() : undefined;
  const sample = await bind(
    clock,
    pause,
    wait &&
      ((eligible, io) =>
        wait(eligible, io, { now: clock.now, pause, monotonic: () => performance.now() })),
    () => ({ signal: new AbortController().signal, deadline: eligible + 2500 }),
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

const io = (deadline = 1000, signal = new AbortController().signal) => ({ deadline, signal });
it('returns the actually observed timestamp after overshoot rather than manufacturing the requested boundary', async () => {
  const wait = await clockFactory();
  let now = 100,
    elapsed = 0;
  const pause = vi.fn(async (ms) => {
    elapsed += ms + 7;
    now += ms + 7;
  });
  expect(await wait(150, io(), { now: () => now, pause, monotonic: () => elapsed })).toBe(157);
  expect(pause).toHaveBeenCalledTimes(1);
});
it('bounds a stalled wall clock and never returns synthetic evidence or leaves an undrained wait', async () => {
  const wait = await clockFactory(),
    pause = vi.fn(async () => {});
  await expect(wait(150, io(), { now: () => 100, pause, monotonic: () => 0 })).rejects.toThrow(
    'PREVIEW_FIXTURE_BOUNDARY',
  );
  expect(pause).toHaveBeenCalledTimes(64);
});
it('does not return a timestamp after the original IO deadline even when the boundary was passed', async () => {
  const wait = await clockFactory();
  let now = 100,
    elapsed = 0;
  await expect(
    wait(150, io(200), {
      now: () => now,
      pause: async () => {
        now = 201;
        elapsed = 101;
      },
      monotonic: () => elapsed,
    }),
  ).rejects.toThrow('PREVIEW_FIXTURE_DEADLINE');
});
it('fails closed on clock regression instead of using a previous or future timestamp', async () => {
  const wait = await clockFactory();
  let now = 100;
  await expect(
    wait(150, io(), {
      now: () => now,
      pause: async () => {
        now = 99;
      },
      monotonic: () => 0,
    }),
  ).rejects.toThrow('PREVIEW_FIXTURE_CLOCK');
});
it('pre-abort starts no timer', async () => {
  const wait = await clockFactory(),
    controller = new AbortController(),
    pause = vi.fn(async () => {});
  controller.abort();
  await expect(
    wait(150, io(1000, controller.signal), { now: () => 100, pause, monotonic: () => 0 }),
  ).rejects.toThrow('PREVIEW_FIXTURE_ABORTED');
  expect(pause).not.toHaveBeenCalled();
});
it('abort during a real owned timer settles the wait and gives no publication timestamp', async () => {
  const wait = await clockFactory(),
    controller = new AbortController(),
    now = Date.now();
  const pending = wait(now + 500, io(now + 1000, controller.signal));
  controller.abort();
  await expect(pending).rejects.toThrow('PREVIEW_FIXTURE_ABORTED');
});
it.each([
  ['invalid target', NaN, 1000, 'INPUT'],
  ['invalid deadline', 150, NaN, 'INPUT'],
  ['boundary at deadline', 200, 200, 'DEADLINE'],
  ['boundary beyond bounded fixture budget', 3000, 10000, 'DEADLINE'],
])('rejects %s before starting a timer', async (_name, target, deadline, reason) => {
  const wait = await clockFactory(),
    pause = vi.fn(async () => {});
  await expect(
    wait(target, io(deadline), { now: () => 100, pause, monotonic: () => 0 }),
  ).rejects.toThrow('PREVIEW_FIXTURE_' + reason);
  expect(pause).not.toHaveBeenCalled();
});
