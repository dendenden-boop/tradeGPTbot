import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, newOrderSchema, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { riskSnapshotKeySchema } from '@ctp/risk-engine';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const priority = z.string().refine((v) => /^[1-9][0-9]{0,18}$/u.test(v) && BigInt(v) < 2n ** 63n);
const prepareSchema = z.strictObject({
  attemptId: uuid,
  preparedAt: timestampSchema,
  admission: z.strictObject({
    binding: riskSnapshotKeySchema.shape.binding,
    orderId: uuid,
    intentId: uuid,
    decisionId: uuid,
    reservationId: uuid,
    dbInstrumentId: uuid,
    dbRuleId: uuid,
    command: newOrderSchema,
    commandHash: digest,
    admissionSequence: priority,
    admittedAt: timestampSchema,
    expiresAt: timestampSchema,
  }),
});
const eventBase = { id: uuid, expectedRevision: z.enum(['1', '2']), at: timestampSchema };
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventBase, kind: z.literal('START') }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('NOT_SENT'),
    reason: z.enum(['CONTROL', 'DEADLINE', 'AUTHORIZATION', 'RULES', 'HEALTH', 'CANCELLED']),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('UNKNOWN'),
    reason: z.enum(['AMBIGUOUS_START_COMMIT', 'AFTER_START']),
  }),
]);
const preparedEvent = z.strictObject({ id: uuid, kind: z.literal('PREPARE'), at: timestampSchema });
const stateSchema = z.strictObject({
  kind: z.literal('PAPER_EXECUTION_ATTEMPT'),
  version: z.literal('paper-pristine-attempt-v1'),
  request: prepareSchema,
  requestHash: digest,
  revision: z.enum(['1', '2', '3']),
  phase: z.enum(['PREPARED', 'STARTED', 'NOT_SENT', 'UNKNOWN']),
  startedAt: timestampSchema.nullable(),
  lastEvent: z.union([preparedEvent, eventSchema]),
});
export type PaperExecutionAttemptRequest = z.infer<typeof prepareSchema>;
export type PaperExecutionAttemptEvent = z.infer<typeof eventSchema>;
export type PaperExecutionAttempt = Readonly<z.infer<typeof stateSchema>>;
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function fail(code: string): never {
  throw Error('PAPER_ATTEMPT_' + code);
}
function bounded(raw: unknown, code: string) {
  try {
    // Protocol content contains no arrays or executable/accessor properties.
    // Reject these before canonicalization or schema traversal can visit an
    // unexpected collection. Bound depth, nodes and strings independently.
    const active = new WeakSet<object>();
    let nodes = 0,
      bytes = 0;
    function visit(value: unknown, depth: number) {
      if (++nodes > 256 || depth > 12) fail(code);
      if (typeof value === 'string') {
        if (value.length > 16384) fail(code);
        bytes += Buffer.byteLength(value);
      } else if (value === null || typeof value === 'boolean') return;
      else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) fail(code);
      } else if (typeof value === 'object') {
        if (Array.isArray(value) || active.has(value)) fail(code);
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) fail(code);
        const keys = Reflect.ownKeys(value);
        if (keys.length > 16) fail(code);
        active.add(value);
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 64) fail(code);
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (!property || !property.enumerable || !('value' in property)) fail(code);
          bytes += Buffer.byteLength(key);
          visit(property.value, depth + 1);
        }
        active.delete(value);
      } else fail(code);
      if (bytes > 16384) fail(code);
    }
    visit(raw, 0);
    if (Buffer.byteLength(canonical(raw)) > 16384) fail(code);
  } catch {
    fail(code);
  }
}
function request(raw: unknown): PaperExecutionAttemptRequest {
  bounded(raw, 'INPUT');
  const checked = prepareSchema.safeParse(raw);
  if (!checked.success) fail('INPUT');
  const r = checked.data,
    a = r.admission,
    b = a.binding,
    c = a.command;
  if (
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.profile.market !== 'SPOT' ||
    b.profile.accountMode !== 'SIMULATED' ||
    b.profile.endpointProfileId !== 'paper-spot-v1' ||
    b.profile.profileVersion !== 'spot-l2-taker-v1' ||
    c.side !== 'BUY' ||
    !['LIMIT', 'MARKET'].includes(c.type) ||
    c.trigger !== null ||
    c.reduceOnly ||
    c.timeInForce === 'POST_ONLY' ||
    c.size.kind !== 'BASE_QUANTITY' ||
    a.admittedAt > r.preparedAt ||
    r.preparedAt >= a.expiresAt ||
    hash({ operation: 'createOrder', command: c, binding: b }) !== a.commandHash
  )
    fail('INPUT');
  return r;
}
function state(raw: unknown): z.infer<typeof stateSchema> {
  bounded(raw, 'STATE');
  const checked = stateSchema.safeParse(raw);
  if (!checked.success) fail('STATE');
  const s = checked.data,
    r = request(s.request),
    e = s.lastEvent;
  if (hash(r) !== s.requestHash || e.at < r.preparedAt) fail('STATE');
  if (s.phase === 'PREPARED') {
    if (
      s.revision !== '1' ||
      s.startedAt !== null ||
      e.kind !== 'PREPARE' ||
      e.id !== r.attemptId ||
      e.at !== r.preparedAt
    )
      fail('STATE');
    return s;
  }
  if (e.kind === 'PREPARE' || e.id === r.attemptId) fail('STATE');
  if (
    s.startedAt !== null &&
    (s.startedAt < r.preparedAt || s.startedAt >= r.admission.expiresAt || e.at < s.startedAt)
  )
    fail('STATE');
  const valid =
    s.phase === 'STARTED'
      ? s.revision === '2' &&
        e.kind === 'START' &&
        e.expectedRevision === '1' &&
        s.startedAt === e.at
      : s.phase === 'NOT_SENT'
        ? s.revision === '2' &&
          e.kind === 'NOT_SENT' &&
          e.expectedRevision === '1' &&
          s.startedAt === null
        : e.kind === 'UNKNOWN' &&
          ((s.revision === '2' &&
            e.expectedRevision === '1' &&
            e.reason === 'AMBIGUOUS_START_COMMIT' &&
            s.startedAt === null) ||
            (s.revision === '3' &&
              e.expectedRevision === '2' &&
              e.reason === 'AFTER_START' &&
              s.startedAt !== null));
  if (!valid) fail('STATE');
  return s;
}

/** Deterministic protocol content only. Neither this JSON nor its plain hash
 * authenticates issuance, creates a durable attempt, grants Risk approval or
 * permits I/O. A private writer must retain the original request and journal
 * atomically, enforce permanent keys and reread current authority at handoff. */
export function preparePaperExecutionAttempt(raw: unknown): PaperExecutionAttempt {
  const r = request(raw);
  return immutable({
    kind: 'PAPER_EXECUTION_ATTEMPT',
    version: 'paper-pristine-attempt-v1',
    request: r,
    requestHash: hash(r),
    revision: '1',
    phase: 'PREPARED',
    startedAt: null,
    lastEvent: { id: r.attemptId, kind: 'PREPARE', at: r.preparedAt },
  });
}

/** Pure replay/ordering contract, not a persisted transition. START describes
 * the final one-use boundary, never the earlier preparation/Risk timestamp.
 * After START, ambiguity cannot become NOT_SENT. No trusted resolution or ACK
 * to FILLED shortcut exists in this pristine protocol. */
export function reducePaperExecutionAttempt(
  raw: unknown,
): Readonly<{ state: PaperExecutionAttempt; ignored: boolean }> {
  bounded(raw, 'INPUT');
  const checked = z.strictObject({ state: z.unknown(), event: eventSchema }).safeParse(raw);
  if (!checked.success) fail('EVENT');
  const s = state(checked.data.state),
    e = checked.data.event;
  if (canonical(e) === canonical(s.lastEvent)) return immutable({ state: s, ignored: true });
  if (e.id === s.lastEvent.id || e.id === s.request.attemptId || e.expectedRevision !== s.revision)
    fail('CONFLICT');
  if (e.at < s.lastEvent.at) fail('EVENT');
  let phase: PaperExecutionAttempt['phase'],
    startedAt = s.startedAt;
  if (s.phase === 'PREPARED') {
    if (e.kind === 'START') {
      if (e.at >= s.request.admission.expiresAt) fail('EXPIRED');
      phase = 'STARTED';
      startedAt = e.at;
    } else if (e.kind === 'NOT_SENT') phase = 'NOT_SENT';
    else if (e.reason === 'AMBIGUOUS_START_COMMIT') phase = 'UNKNOWN';
    else fail('TRANSITION');
  } else if (s.phase === 'STARTED' && e.kind === 'UNKNOWN' && e.reason === 'AFTER_START')
    phase = 'UNKNOWN';
  else fail('TRANSITION');
  const next = state({
    ...s,
    revision: s.revision === '1' ? '2' : '3',
    phase,
    startedAt,
    lastEvent: e,
  });
  return immutable({ state: next, ignored: false });
}

/** Initial zero-fill calculation input only, never a dispatch permit or proof
 * of pristine history. The future fixed writer must read its durable START and
 * complete unconsumed history; replaying this JSON cannot reset shared volume.
 * Historical grant expiry does not rewrite a known START as NOT_SENT. */
export function projectPristinePaperExecutionAttempt(raw: unknown) {
  bounded(raw, 'PROJECTION');
  const checked = z.strictObject({ state: z.unknown(), now: timestampSchema }).safeParse(raw);
  if (!checked.success) fail('PROJECTION');
  const s = state(checked.data.state);
  if (s.phase !== 'STARTED' || s.startedAt === null || s.startedAt > checked.data.now)
    fail('PROJECTION');
  return immutable({
    orderId: s.request.admission.orderId,
    admissionSequence: s.request.admission.admissionSequence,
    order: s.request.admission.command,
    submittedAt: s.startedAt,
    executedQuantity: '0',
    triggeredAt: null,
  });
}
