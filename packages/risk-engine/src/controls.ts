import { z } from 'zod';
const epoch = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((v) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) < 9223372036854775807n);
const tenantScope = (kind: 'USER' | 'CONNECTION' | 'STRATEGY') =>
  z.strictObject({
    kind: z.literal(kind),
    tenantId: z.uuid(),
    targetId: z.uuid(),
  });
export const controlScopeSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('GLOBAL') }),
    tenantScope('USER'),
    tenantScope('CONNECTION'),
    tenantScope('STRATEGY'),
  ])
  .superRefine((s, c) => {
    if (s.kind === 'USER' && s.tenantId !== s.targetId)
      c.addIssue({ code: 'custom', message: 'RISK_CONTROL_SCOPE' });
  });
export const controlUpdateSchema = z
  .strictObject({
    scope: controlScopeSchema,
    kind: z.enum(['KILL_SWITCH', 'CIRCUIT']),
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    state: z.enum(['PAUSED', 'RUNNING', 'OPEN', 'CLOSED', 'HALF_OPEN']),
    eventId: z.uuid(),
    expectedEpoch: epoch,
    reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((u, c) => {
    if (
      u.kind === 'KILL_SWITCH'
        ? u.key !== 'kill' || !['PAUSED', 'RUNNING'].includes(u.state)
        : !['OPEN', 'CLOSED', 'HALF_OPEN'].includes(u.state)
    )
      c.addIssue({ code: 'custom', message: 'RISK_CONTROL_STATE' });
  });
export type ControlScope = z.infer<typeof controlScopeSchema>;
export type ControlUpdate = z.infer<typeof controlUpdateSchema>;
