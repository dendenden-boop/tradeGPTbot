import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const requireDatabase = createRequire(
  new URL('../packages/database/package.json', import.meta.url),
);
const { Pool } = requireDatabase('pg');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQxMjM0NTY3OA$' + 'A'.repeat(43);
const hash = () => randomBytes(32);

/** Called only with the integration runner's owned upgrade DB, before and after 005. */
export async function exerciseAuthDatabaseHardening({ admin, adminUrl, authUrl, stage }) {
  for (const value of [adminUrl, authUrl]) {
    const url = new URL(value);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/ctp_p2_upgrade_[a-f0-9]+$/);
  }
  assert.equal(new URL(adminUrl).pathname, new URL(authUrl).pathname);
  assert.ok(['published004', 'hardened005'].includes(stage));
  const original = stage === 'published004';
  const auth = new Pool({ connectionString: authUrl, max: 3, query_timeout: 7000 });
  auth.on('error', () => {});
  const writerPool = new Pool({ connectionString: adminUrl, max: 1, query_timeout: 7000 });
  const query = (sql, values = []) => auth.query(sql, values);
  async function account(verified = true) {
    const email = `${randomUUID()}@hardening.invalid`;
    const verification = hash();
    assert.equal(
      (await query('SELECT ctp_auth.signup($1,$2,$3) AS ok', [email, passwordHash, verification]))
        .rows[0].ok,
      true,
    );
    if (verified)
      assert.equal(
        (await query('SELECT ctp_auth.verify_email($1) AS ok', [verification])).rows[0].ok,
        true,
      );
    const id = (
      await admin.query('SELECT id FROM public."user" WHERE "emailNormalized"=$1', [email])
    ).rows[0].id;
    return { id, email, verification };
  }
  async function createSession(user) {
    const token = hash();
    const rows = (
      await query('SELECT * FROM ctp_auth.create_session($1,$2,0,$3,NULL)', [
        user.id,
        passwordHash,
        token,
      ])
    ).rows;
    assert.equal(rows.length, 1);
    return { token, principal: rows[0] };
  }
  async function stats() {
    await admin.query('SELECT pg_stat_clear_snapshot()');
    return (
      await admin.query(`SELECT n_tup_upd::float8 AS updates,n_dead_tup::float8 AS "deadTuples",
      pg_current_wal_insert_lsn()::text AS lsn FROM pg_stat_user_tables WHERE relname='user_session'`)
    ).rows[0];
  }
  async function flushPoolStats(pool) {
    // Client socket closure does not wait for PostgreSQL's asynchronous stats
    // publication. Pin every connection so each backend flushes its counters;
    // the subsequent round trip crosses the idle/report boundary. This is
    // outside the timed authenticate batch and retains exact UPDATE assertions.
    const connections = [];
    try {
      for (let index = 0; index < 3; index++) connections.push(await pool.connect());
      await Promise.all(
        connections.map(async (connection) => {
          await connection.query('SELECT pg_stat_force_next_flush()');
          await connection.query('SELECT 1');
        }),
      );
    } finally {
      for (const connection of connections) connection.release();
    }
  }
  const percentile = (values, fraction) =>
    Number(values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)].toFixed(3));
  try {
    assert.equal(
      (await query('SELECT ctp_auth.schema_version() AS version')).rows[0].version,
      original ? 4 : 5,
    );
    const verified = await account();
    const active = await createSession(verified);

    // An outsider can request a new link but must not consume the existing one.
    const recovery = await account();
    const firstReset = hash();
    assert.equal(
      (
        await query('SELECT ctp_auth.issue_password_reset($1,$2) AS ok', [
          recovery.email,
          firstReset,
        ])
      ).rows[0].ok,
      true,
    );
    const secondResetIssued = (
      await query('SELECT ctp_auth.issue_password_reset($1,$2) AS ok', [recovery.email, hash()])
    ).rows[0].ok;
    const firstResetUsable = (
      await query('SELECT ctp_auth.reset_password($1,$2) AS ok', [firstReset, passwordHash])
    ).rows[0].ok;
    assert.equal(secondResetIssued, original);
    assert.equal(firstResetUsable, !original);
    const pending = await account(false);
    const replacementVerificationIssued = (
      await query('SELECT ctp_auth.issue_verification($1,$2) AS ok', [pending.email, hash()])
    ).rows[0].ok;
    const originalVerificationUsable = (
      await query('SELECT ctp_auth.verify_email($1) AS ok', [pending.verification])
    ).rows[0].ok;
    assert.equal(replacementVerificationIssued, original);
    assert.equal(originalVerificationUsable, !original);

    const suffix = randomUUID();
    const malformed = [
      `.${suffix}@invalid.example`,
      `${'a'.repeat(65)}@${suffix}.invalid`,
      `a@${'a'.repeat(64)}.${suffix}.invalid`,
    ];
    let malformedMailboxesAccepted = 0;
    for (const email of malformed) {
      try {
        if (
          (await query('SELECT ctp_auth.signup($1,$2,$3) AS ok', [email, passwordHash, hash()]))
            .rows[0].ok
        )
          malformedMailboxesAccepted += 1;
      } catch (error) {
        assert.equal(error.code, '22023');
      }
    }
    assert.equal(malformedMailboxesAccepted, original ? malformed.length : 0);

    // Published 004's VOLATILE MFA helper is fresh only under READ COMMITTED.
    // A caller-owned historical snapshot must not create a password-only session.
    const mfaAccount = await account();
    const historical = await auth.connect();
    let staleSnapshotCreatedSession = false;
    let historicalSnapshotRejected = false;
    try {
      await historical.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      if (original) {
        await historical.query('SELECT * FROM ctp_auth.credentials($1)', [mfaAccount.email]);
        const writer = await writerPool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query('SELECT id FROM public."user" WHERE id=$1 FOR UPDATE', [
            mfaAccount.id,
          ]);
          await writer.query(
            `INSERT INTO public.two_factor_config
            ("tenantId",ciphertext,nonce,tag,"wrappedDek","kmsKeyId","kmsKeyVersion","encryptionVersion","aadVersion","enabledAt","updatedAt")
            VALUES ($1,$2,$3,$4,$2,'fixture-only','1',1,1,now(),now())`,
            [mfaAccount.id, hash(), Buffer.alloc(12, 1), Buffer.alloc(16, 2)],
          );
          await writer.query('COMMIT');
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
        staleSnapshotCreatedSession =
          (
            await historical.query('SELECT * FROM ctp_auth.create_session($1,$2,0,$3,NULL)', [
              mfaAccount.id,
              passwordHash,
              hash(),
            ])
          ).rows.length === 1;
        assert.equal(staleSnapshotCreatedSession, true);
      } else {
        await assert.rejects(
          historical.query('SELECT * FROM ctp_auth.credentials($1)', [mfaAccount.email]),
          (error) => error.code === '25001',
        );
        historicalSnapshotRejected = true;
      }
    } finally {
      await historical.query('ROLLBACK');
      historical.release();
    }

    // Deterministic contention proof, independent of noisy percentile measurements.
    const writer = await writerPool.connect();
    let lockWaitObserved = false;
    let completedWhileUserLocked = false;
    let pendingAuthentication;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM public."user" WHERE id=$1 FOR UPDATE', [verified.id]);
      pendingAuthentication = query('SELECT * FROM ctp_auth.authenticate($1)', [active.token]).then(
        (result) => {
          completedWhileUserLocked = true;
          return result;
        },
      );
      const deadline = performance.now() + 1500;
      while (performance.now() < deadline && !completedWhileUserLocked && !lockWaitObserved) {
        lockWaitObserved = (
          await admin.query(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock') AS waiting`,
            [new URL(authUrl).username],
          )
        ).rows[0].waiting;
        if (!completedWhileUserLocked && !lockWaitObserved) await delay(5);
      }
      assert.equal(lockWaitObserved, original);
      assert.equal(completedWhileUserLocked, !original);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      if (pendingAuthentication) assert.equal((await pendingAuthentication).rows.length, 1);
    }
    await flushPoolStats(auth);
    await auth.end();

    const measurements = [];
    for (const concurrency of [10, 50, 100]) {
      const pool = new Pool({
        connectionString: authUrl,
        max: 3,
        connectionTimeoutMillis: 1000,
        query_timeout: 3500,
        statement_timeout: 3000,
      });
      pool.on('error', () => {});
      let sampler;
      let sampling;
      let maxWaitingRequests = 0;
      let maxActiveBackends = 0;
      let maxLockWaits = 0;
      let sampleFailure = false;
      const latency = [];
      let before;
      try {
        await Promise.all(Array.from({ length: 3 }, () => pool.query('SELECT 1')));
        before = await stats();
        sampler = setInterval(() => {
          maxWaitingRequests = Math.max(maxWaitingRequests, pool.waitingCount);
          if (sampling) return;
          sampling = admin
            .query(
              `SELECT count(*) FILTER (WHERE state='active')::int AS active,
            count(*) FILTER (WHERE wait_event_type='Lock')::int AS locks FROM pg_stat_activity
            WHERE datname=current_database() AND usename=$1`,
              [new URL(authUrl).username],
            )
            .then((result) => {
              maxActiveBackends = Math.max(maxActiveBackends, result.rows[0].active);
              maxLockWaits = Math.max(maxLockWaits, result.rows[0].locks);
            })
            .catch(() => {
              sampleFailure = true;
            })
            .finally(() => {
              sampling = undefined;
            });
        }, 5);
        const requests = Array.from({ length: concurrency }, async () => {
          const started = performance.now();
          const result = await pool.query('SELECT * FROM ctp_auth.authenticate($1)', [
            active.token,
          ]);
          latency.push(performance.now() - started);
          assert.equal(result.rows.length, 1);
        });
        maxWaitingRequests = Math.max(maxWaitingRequests, pool.waitingCount);
        await Promise.all(requests);
      } finally {
        clearInterval(sampler);
        await sampling;
        try {
          await flushPoolStats(pool);
        } finally {
          await pool.end();
        }
      }
      assert.equal(sampleFailure, false);
      const after = await stats();
      const sessionUpdates = after.updates - before.updates;
      assert.equal(sessionUpdates, original ? concurrency : 0);
      const walBytes = Number(
        (
          await admin.query('SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::text AS bytes', [
            after.lsn,
            before.lsn,
          ])
        ).rows[0].bytes,
      );
      latency.sort((a, b) => a - b);
      measurements.push({
        concurrency,
        poolMax: 3,
        p50Ms: percentile(latency, 0.5),
        p95Ms: percentile(latency, 0.95),
        p99Ms: percentile(latency, 0.99),
        sessionUpdates,
        approximateWalBytes: walBytes,
        approximateDeadTuplesDelta: after.deadTuples - before.deadTuples,
        maxWaitingRequests,
        maxActiveBackends,
        maxLockWaits,
        errors: 0,
      });
    }
    return {
      stage,
      schemaVersion: original ? 4 : 5,
      postgresVersion: (await admin.query('SHOW server_version')).rows[0].server_version,
      secondResetIssued,
      firstResetUsable,
      replacementVerificationIssued,
      originalVerificationUsable,
      malformedMailboxesAccepted,
      staleSnapshotCreatedSession,
      historicalSnapshotRejected,
      lockWaitObserved,
      completedWhileUserLocked: !original,
      measurements,
    };
  } finally {
    if (!auth.ended) await auth.end();
    await writerPool.end();
  }
}
