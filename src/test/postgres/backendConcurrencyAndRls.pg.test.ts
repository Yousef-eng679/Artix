// @vitest-environment node
/**
 * ============================================================================
 * ARTIX LAYER 3 — REAL POSTGRESQL BACKEND CONCURRENCY, CAS, BILLING & RLS SUITE
 * (TASK-13 / Mandatory Amendment E)
 *
 * Dual-Backend Architecture:
 *   1. Multi-Session TCP Pool (`DATABASE_URL` set — GitHub Actions CI
 *      `postgres:17` service container OR local `supabase start`):
 *      Connects via `pg.Pool` (`max: 10`) using independent PostgreSQL backend
 *      processes to prove multi-connection `pg_advisory_xact_lock` serialization,
 *      concurrent CAS `apply_sync_mutation` races, concurrent Free-tier quota
 *      triggers (`check_plan_tier_limit`), and concurrent Stripe webhook
 *      reconciliation (`reconcile_stripe_subscription`).
 *   2. Embedded Real PostgreSQL (`DATABASE_URL` unset — local `npm run test`
 *      on machines without Docker):
 *      Boots `@electric-sql/pglite` (compiled PostgreSQL engine in WASM) and
 *      executes all 25 SQL migrations in `supabase/migrations/*.sql` plus the
 *      complete PL/pgSQL, trigger, CAS, retention, billing, and RLS suite.
 *
 * Amendment E — Explicit Supabase Auth Shim Disclosure:
 *   - When `DATABASE_URL` points to `supabase start`, `auth.users`, `auth.uid()`,
 *     and roles `anon`, `authenticated`, and `service_role` already exist natively
 *     (`to_regprocedure('auth.uid()') IS NOT NULL`), so the auth bootstrap shim
 *     is skipped automatically.
 *   - When running on vanilla `postgres:17` (CI service container) or embedded
 *     `PGlite`, `bootstrapSupabaseAuthShimIfNeeded()` provisions:
 *       * NOLOGIN roles `anon`, `authenticated`, and `service_role` (`BYPASSRLS`)
 *         granted to `CURRENT_USER` so `SET LOCAL ROLE <role>` switches security
 *         context identically to PostgREST per-request transactions.
 *       * Standard Supabase `public` schema default privileges (`GRANT ALL ON
 *         TABLES/SEQUENCES/ROUTINES TO anon, authenticated, service_role`), so
 *         access is governed strictly by `ENABLE ROW LEVEL SECURITY` policies
 *         and explicit `REVOKE`/`GRANT` statements inside `supabase/migrations/`.
 *       * Minimal `auth.users(id, email, raw_user_meta_data, created_at, updated_at)`
 *         and `auth.uid()` reading `request.jwt.claim.sub` / `request.jwt.claims`.
 *   - Differences vs full `supabase start`: GoTrue HTTP `/auth/v1/*` endpoints,
 *     PostgREST HTTP schema-cache routing, `supabase_realtime` WAL consumers, and
 *     `storage` S3 buckets are not started here; HTTP/Realtime/PWA cold-start
 *     layers are tested in Layer 2 (`controllableFakeServerFaultInjection.test.ts`)
 *     and Layer 4 (`tests/e2e/offlineColdStartAndSyncMatrix.spec.ts`).
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface QueryResultRow {
  [column: string]: unknown;
}

interface SqlSession {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
}

interface PgHarness {
  readonly isMultiSessionPool: boolean;
  withTransaction<T>(fn: (tx: SqlSession) => Promise<T>): Promise<T>;
  withAsRole<T>(
    role: 'anon' | 'authenticated' | 'service_role',
    userId: string | null,
    fn: (tx: SqlSession) => Promise<T>,
  ): Promise<T>;
  execSuperuserSql(sql: string): Promise<void>;
  querySuperuser<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase', 'migrations');
const EXPAND_MIGRATION = '20261101100000_expand_sync_protocol_and_projects.sql';
const CONTRACT_MIGRATION = '20261101100100_contract_strict_cas_base_version.sql';

function wrapPoolClient(client: PoolClient): SqlSession {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

async function createPgHarness(): Promise<PgHarness> {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl) {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 10_000,
    });

    return {
      isMultiSessionPool: true,
      async withTransaction<T>(fn: (tx: SqlSession) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(wrapPoolClient(client));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      },
      async withAsRole<T>(
        role: 'anon' | 'authenticated' | 'service_role',
        userId: string | null,
        fn: (tx: SqlSession) => Promise<T>,
      ): Promise<T> {
        return this.withTransaction(async (tx) => {
          const claims = userId
            ? JSON.stringify({ sub: userId, role })
            : JSON.stringify({ role });
          await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
          await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
          await tx.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
          await tx.exec(`SET LOCAL ROLE ${role}`);
          return fn(tx);
        });
      },
      async execSuperuserSql(sql: string): Promise<void> {
        const client = await pool.connect();
        try {
          await client.query(sql);
        } finally {
          client.release();
        }
      },
      async querySuperuser<T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params?: unknown[],
      ) {
        const client = await pool.connect();
        try {
          const res = await client.query(sql, params);
          return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
        } finally {
          client.release();
        }
      },
      async close(): Promise<void> {
        await pool.end();
      },
    };
  }

  const pglite = new PGlite();
  return {
    isMultiSessionPool: false,
    async withTransaction<T>(fn: (tx: SqlSession) => Promise<T>): Promise<T> {
      return pglite.transaction(async (pgTx) => {
        const session: SqlSession = {
          async query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
            const res = await pgTx.query<R>(sql, params);
            return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
          },
          async exec(sql: string) {
            await pgTx.exec(sql);
          },
        };
        return fn(session);
      });
    },
    async withAsRole<T>(
      role: 'anon' | 'authenticated' | 'service_role',
      userId: string | null,
      fn: (tx: SqlSession) => Promise<T>,
    ): Promise<T> {
      return this.withTransaction(async (tx) => {
        const claims = userId
          ? JSON.stringify({ sub: userId, role })
          : JSON.stringify({ role });
        await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
        await tx.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
        await tx.exec(`SET LOCAL ROLE ${role}`);
        return fn(tx);
      });
    },
    async execSuperuserSql(sql: string): Promise<void> {
      await pglite.exec(sql);
    },
    async querySuperuser<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ) {
      const res = await pglite.query<T>(sql, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
    async close(): Promise<void> {
      await pglite.close();
    },
  };
}

async function bootstrapSupabaseAuthShimIfNeeded(pg: PgHarness): Promise<void> {
  const existingAuth = await pg.querySuperuser<{ uid_fn: string | null }>(
    `SELECT to_regprocedure('auth.uid()')::text AS uid_fn`,
  );
  if (existingAuth.rows[0]?.uid_fn) {
    // Running against full `supabase start` — native auth schema & roles already exist.
    return;
  }

  await pg.execSuperuserSql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
      END IF;
    END
    $$;

    GRANT anon, authenticated, service_role TO CURRENT_USER;

    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON ROUTINES TO anon, authenticated, service_role;

    CREATE SCHEMA IF NOT EXISTS auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

    CREATE TABLE IF NOT EXISTS auth.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE,
      raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS UUID
    LANGUAGE sql
    STABLE
    AS $fn$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::UUID;
    $fn$;

    GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC, anon, authenticated, service_role;
  `);
}

async function createTestUser(pg: PgHarness, label: string): Promise<string> {
  const userId = randomUUID();
  const safeEmail = `${label}-${userId.slice(0, 8)}@example.test`;
  await pg.querySuperuser(
    `INSERT INTO auth.users (id, email, raw_user_meta_data)
     VALUES ($1::uuid, $2::text, jsonb_build_object('display_name', $3::text))`,
    [userId, safeEmail, label],
  );
  return userId;
}

describe('Layer 3 — Real PostgreSQL Backend Concurrency, CAS, Billing & RLS (TASK-13 / Amendment E)', () => {
  let pg: PgHarness;
  let migrationFiles: string[] = [];

  beforeAll(async () => {
    pg = await createPgHarness();
    await bootstrapSupabaseAuthShimIfNeeded(pg);

    migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    expect(migrationFiles.length).toBeGreaterThanOrEqual(25);

    const alreadyMigrated = await pg.querySuperuser<{ tbl: string | null }>(
      `SELECT to_regclass('public.manual_grants')::text AS tbl`,
    );

    if (!alreadyMigrated.rows[0]?.tbl) {
      for (const file of migrationFiles) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        try {
          await pg.execSuperuserSql(sql);
        } catch (err) {
          throw new Error(
            `Migration failed on real PostgreSQL: ${file} -> ${(err as Error).message}`,
          );
        }
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  it('proves Expand -> Contract rollout window for p_base_version CAS enforcement and blocks auth spoofing (C-01, TASK-01A, TASK-01B)', async () => {
    const userA = await createTestUser(pg, 'cas-rollout-a');
    const userB = await createTestUser(pg, 'cas-rollout-b');
    const projectId = randomUUID();
    const docId = randomUUID();

    // 1. Temporarily load Expand-phase RPC (`20261101100000`) to verify legacy NULL base compatibility
    const expandSql = fs.readFileSync(path.join(MIGRATIONS_DIR, EXPAND_MIGRATION), 'utf8');
    await pg.execSuperuserSql(expandSql);

    await pg.withAsRole('authenticated', userA, async (tx) => {
      const createProj = await tx.query<{ res: { status: string; version: number } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'create', NULL, '{"name":"Expand Project"}'::jsonb, NULL) AS res`,
        [randomUUID(), userA, projectId],
      );
      expect(createProj.rows[0].res.status).toBe('applied');
      expect(createProj.rows[0].res.version).toBe(1);

      const createDoc = await tx.query<{ res: { status: string; version: number } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Doc v1","content":"hello"}'::jsonb, NULL) AS res`,
        [randomUUID(), userA, docId, projectId],
      );
      expect(createDoc.rows[0].res.status).toBe('applied');
      expect(createDoc.rows[0].res.version).toBe(1);

      // Expand phase permits legacy NULL p_base_version while older cached tabs drain
      const legacyUpdate = await tx.query<{ res: { status: string; version: number } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"expand legacy update"}'::jsonb, NULL) AS res`,
        [randomUUID(), userA, docId, projectId],
      );
      expect(legacyUpdate.rows[0].res.status).toBe('applied');
      expect(legacyUpdate.rows[0].res.version).toBe(2);
    });

    // 2. Apply Contract-phase RPC (`20261101100100`) — strict fail-closed CAS permanently active
    const contractSql = fs.readFileSync(path.join(MIGRATIONS_DIR, CONTRACT_MIGRATION), 'utf8');
    await pg.execSuperuserSql(contractSql);

    // Rejects NULL p_base_version on update with SQLSTATE 22023
    await expect(
      pg.withAsRole('authenticated', userA, (tx) =>
        tx.query(
          `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"illegal null"}'::jsonb, NULL)`,
          [randomUUID(), userA, docId, projectId],
        ),
      ),
    ).rejects.toMatchObject({ code: '22023' });

    // Rejects non-positive p_base_version = 0 on delete with SQLSTATE 22023
    await expect(
      pg.withAsRole('authenticated', userA, (tx) =>
        tx.query(
          `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'delete', $4::uuid, '{}'::jsonb, 0)`,
          [randomUUID(), userA, docId, projectId],
        ),
      ),
    ).rejects.toMatchObject({ code: '22023' });

    // Rejects p_user_id spoofing (auth.uid() = userA attempting p_user_id = userB) with SQLSTATE 42501
    await expect(
      pg.withAsRole('authenticated', userA, (tx) =>
        tx.query(
          `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'create', NULL, '{"name":"Spoof"}'::jsonb, NULL)`,
          [randomUUID(), userB, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces idempotency ledger, structured CAS conflict reasons, root-only mutation_id stamping, and monotonic sync_changes sequences (S-01, S-03, F-001, F-003)', async () => {
    const userId = await createTestUser(pg, 'sync-cas');
    const projectId = randomUUID();
    const docId = randomUUID();
    const createDocMutId = randomUUID();
    const updateDocMutId = randomUUID();
    const deleteProjMutId = randomUUID();

    await pg.withAsRole('authenticated', userId, async (tx) => {
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'create', NULL, '{"name":"Core Sync Project"}'::jsonb, NULL)`,
        [randomUUID(), userId, projectId],
      );

      const created = await tx.query<{ res: { status: string; version: number } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Spec","content":"v1"}'::jsonb, NULL) AS res`,
        [createDocMutId, userId, docId, projectId],
      );
      expect(created.rows[0].res).toMatchObject({ status: 'applied', version: 1 });

      // Idempotent replay of createDocMutId returns already_processed without bumping version
      const replay = await tx.query<{ res: { status: string; version: number } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Spec","content":"v1"}'::jsonb, NULL) AS res`,
        [createDocMutId, userId, docId, projectId],
      );
      expect(replay.rows[0].res).toMatchObject({ status: 'already_processed', version: 1 });

      // Valid CAS update (base 1 -> v2)
      const updated = await tx.query<{ res: { status: string; version: number } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"v2 authoritative"}'::jsonb, 1) AS res`,
        [updateDocMutId, userId, docId, projectId],
      );
      expect(updated.rows[0].res).toMatchObject({ status: 'applied', version: 2 });

      // Stale CAS update (base 1 when row is v2) -> structured version_mismatch + current_row
      const mismatch = await tx.query<{
        res: {
          status: string;
          reason: string;
          current_version: number;
          current_row: { content: string };
        };
      }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"stale overwrite"}'::jsonb, 1) AS res`,
        [randomUUID(), userId, docId, projectId],
      );
      expect(mismatch.rows[0].res).toMatchObject({
        status: 'conflict',
        reason: 'version_mismatch',
        current_version: 2,
      });
      expect(mismatch.rows[0].res.current_row.content).toBe('v2 authoritative');

      // Verify sync_changes stamped updateDocMutId for self-echo recognition
      const echoCheck = await tx.query<{ mutation_id: string | null; entity_version: string }>(
        `SELECT mutation_id::text, entity_version::text
           FROM public.sync_changes
          WHERE user_id = $1::uuid
            AND entity_type = 'document'
            AND entity_id = $2
            AND operation = 'update'`,
        [userId, docId],
      );
      expect(echoCheck.rows).toHaveLength(1);
      expect(echoCheck.rows[0].mutation_id).toBe(updateDocMutId);
      expect(Number(echoCheck.rows[0].entity_version)).toBe(2);
    });

    // Delete document at v2, then try to update deleted document -> structured remote_deleted
    const docToDelete = randomUUID();
    await pg.withAsRole('authenticated', userId, async (tx) => {
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Temp","content":"bye"}'::jsonb, NULL)`,
        [randomUUID(), userId, docToDelete, projectId],
      );
      const delRes = await tx.query<{ res: { status: string; version: number | null } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'delete', $4::uuid, '{}'::jsonb, 1) AS res`,
        [randomUUID(), userId, docToDelete, projectId],
      );
      expect(delRes.rows[0].res).toMatchObject({ status: 'applied', version: null });

      const remoteDeleted = await tx.query<{
        res: { status: string; reason: string; current_version: number | null };
      }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"orphan edit"}'::jsonb, 1) AS res`,
        [randomUUID(), userId, docToDelete, projectId],
      );
      expect(remoteDeleted.rows[0].res).toEqual({
        status: 'conflict',
        reason: 'remote_deleted',
        current_version: null,
      });
    });

    // Delete parent project -> cascades child docId delete; mutation_id MUST only stamp root project delete!
    await pg.withAsRole('authenticated', userId, async (tx) => {
      const projDel = await tx.query<{ res: { status: string } }>(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'delete', NULL, '{}'::jsonb, 1) AS res`,
        [deleteProjMutId, userId, projectId],
      );
      expect(projDel.rows[0].res.status).toBe('applied');

      const deleteFeed = await tx.query<{
        sequence: string;
        entity_type: string;
        entity_id: string;
        mutation_id: string | null;
      }>(
        `SELECT sequence::text, entity_type, entity_id, mutation_id::text
           FROM public.sync_changes
          WHERE user_id = $1::uuid
            AND operation = 'delete'
          ORDER BY sequence ASC`,
        [userId],
      );

      const rootProjectDelete = deleteFeed.rows.find(
        (r) => r.entity_type === 'project' && r.entity_id === projectId,
      );
      const cascadedChildDelete = deleteFeed.rows.find(
        (r) => r.entity_type === 'document' && r.entity_id === docId,
      );

      expect(rootProjectDelete?.mutation_id).toBe(deleteProjMutId);
      expect(cascadedChildDelete).toBeDefined();
      expect(cascadedChildDelete?.mutation_id).toBeNull();
    });
  });

  it('advances sync_retention_state.min_retained_sequence monotonically during prune_sync_changes and exposes bounds via get_sync_feed_bounds (TASK-20, TASK-27)', async () => {
    const userId = await createTestUser(pg, 'retention-user');
    const projectId = randomUUID();

    await pg.withAsRole('authenticated', userId, async (tx) => {
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'create', NULL, '{"name":"Retention Proj"}'::jsonb, NULL)`,
        [randomUUID(), userId, projectId],
      );
      for (let i = 0; i < 3; i += 1) {
        await tx.query(
          `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Aged Doc"}'::jsonb, NULL)`,
          [randomUUID(), userId, randomUUID(), projectId],
        );
      }
    });

    // Authenticated callers are forbidden from invoking prune_sync_changes directly
    await expect(
      pg.withAsRole('authenticated', userId, (tx) =>
        tx.query(`SELECT public.prune_sync_changes(INTERVAL '30 days', 100)`),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Backdate all sync_changes rows up to the user's 2nd row so contiguous prefix is prunable
    const userSeqs = await pg.querySuperuser<{ sequence: string }>(
      `SELECT sequence::text FROM public.sync_changes WHERE user_id = $1::uuid ORDER BY sequence ASC`,
      [userId],
    );
    const cutoffSeq = Number(userSeqs.rows[1].sequence);
    await pg.querySuperuser(
      `UPDATE public.sync_changes
          SET changed_at = now() - INTERVAL '45 days'
        WHERE sequence <= $1`,
      [cutoffSeq],
    );

    const pruneRes = await pg.withAsRole('service_role', null, async (tx) => {
      const res = await tx.query<{
        out: { deleted_count: number; min_retained_sequence: number };
      }>(`SELECT public.prune_sync_changes(INTERVAL '30 days', 500) AS out`);
      return res.rows[0].out;
    });

    expect(pruneRes.deleted_count).toBeGreaterThanOrEqual(2);
    expect(pruneRes.min_retained_sequence).toBe(cutoffSeq);

    const bounds = await pg.withAsRole('authenticated', userId, async (tx) => {
      const res = await tx.query<{
        out: { min_retained_sequence: number; max_sequence: number };
      }>(`SELECT public.get_sync_feed_bounds() AS out`);
      return res.rows[0].out;
    });

    expect(bounds.min_retained_sequence).toBe(cutoffSeq);
    expect(bounds.max_sequence).toBeGreaterThan(cutoffSeq);
  });

  it('enforces Free quotas (projects, documents, system_designs, monthly AI generations), excludes soft-deleted rows, fails closed on past_due, and honors/revokes manual_grants (B-01..B-03, F-005, TASK-04, TASK-23)', async () => {
    const userId = await createTestUser(pg, 'quota-billing-user');

    // Verify handle_new_user() auto-created profile + free active subscription
    const initialSub = await pg.withAsRole('authenticated', userId, (tx) =>
      tx.query<{ plan_tier: string; status: string }>(
        `SELECT plan_tier, status FROM public.subscriptions WHERE user_id = $1::uuid`,
        [userId],
      ),
    );
    expect(initialSub.rows[0]).toEqual({ plan_tier: 'free', status: 'active' });

    // 1. Free project limit = 3 active projects; soft-deleted projects do NOT count
    const projectIds = [randomUUID(), randomUUID(), randomUUID()];
    await pg.withAsRole('authenticated', userId, async (tx) => {
      for (const pid of projectIds) {
        await tx.query(
          `INSERT INTO public.projects (id, user_id, name) VALUES ($1::uuid, $2::uuid, 'Proj')`,
          [pid, userId],
        );
      }
    });

    await expect(
      pg.withAsRole('authenticated', userId, (tx) =>
        tx.query(
          `INSERT INTO public.projects (id, user_id, name) VALUES ($1::uuid, $2::uuid, 'Proj 4')`,
          [randomUUID(), userId],
        ),
      ),
    ).rejects.toThrow(/Free tier project limit \(3\) reached/);

    // Soft-delete projectIds[2] -> 4th insert now succeeds!
    await pg.withAsRole('authenticated', userId, async (tx) => {
      await tx.query(
        `UPDATE public.projects SET deleted_at = now() WHERE id = $1::uuid`,
        [projectIds[2]],
      );
      await tx.query(
        `INSERT INTO public.projects (id, user_id, name) VALUES ($1::uuid, $2::uuid, 'Replacement Proj')`,
        [randomUUID(), userId],
      );
    });

    const primaryProject = projectIds[0];

    // 2. Free document limit = 10 active documents; soft-deleted documents do NOT count
    const docIds: string[] = [];
    await pg.withAsRole('authenticated', userId, async (tx) => {
      for (let i = 0; i < 10; i += 1) {
        const id = randomUUID();
        docIds.push(id);
        await tx.query(
          `INSERT INTO public.documents (id, user_id, project_id, title, content)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '')`,
          [id, userId, primaryProject, `Doc ${i + 1}`],
        );
      }
    });

    await expect(
      pg.withAsRole('authenticated', userId, (tx) =>
        tx.query(
          `INSERT INTO public.documents (id, user_id, project_id, title, content)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Doc 11', '')`,
          [randomUUID(), userId, primaryProject],
        ),
      ),
    ).rejects.toThrow(/Free tier document limit \(10\) reached/);

    // 3. Free system_design limit = 3 active designs
    await pg.withAsRole('authenticated', userId, async (tx) => {
      for (let i = 0; i < 3; i += 1) {
        await tx.query(
          `INSERT INTO public.system_designs (id, user_id, project_id, name)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
          [randomUUID(), userId, primaryProject, `Design ${i + 1}`],
        );
      }
    });

    await expect(
      pg.withAsRole('authenticated', userId, (tx) =>
        tx.query(
          `INSERT INTO public.system_designs (id, user_id, project_id, name)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Design 4')`,
          [randomUUID(), userId, primaryProject],
        ),
      ),
    ).rejects.toThrow(/Free tier system design limit \(3\) reached/);

    // 4. Free monthly AI generation limit = 5 combined across prd_generations, vibe_generations, agentic_workflows
    await pg.withAsRole('authenticated', userId, async (tx) => {
      await tx.query(
        `INSERT INTO public.prd_generations (user_id, project_id, template, output_markdown)
         VALUES ($1::uuid, $2::uuid, 'standard', '# PRD 1'),
                ($1::uuid, $2::uuid, 'standard', '# PRD 2')`,
        [userId, primaryProject],
      );
      await tx.query(
        `INSERT INTO public.vibe_generations (user_id, project_id, target, scope, output_markdown)
         VALUES ($1::uuid, $2::uuid, 'cursor', 'full', '# Vibe 1'),
                ($1::uuid, $2::uuid, 'cursor', 'full', '# Vibe 2')`,
        [userId, primaryProject],
      );
      await tx.query(
        `INSERT INTO public.agentic_workflows (user_id, project_id, pattern, agent_count, output_markdown)
         VALUES ($1::uuid, $2::uuid, 'supervisor', 3, '# Workflow 1')`,
        [userId, primaryProject],
      );
    });

    await expect(
      pg.withAsRole('authenticated', userId, (tx) =>
        tx.query(
          `INSERT INTO public.prd_generations (user_id, project_id, template, output_markdown)
           VALUES ($1::uuid, $2::uuid, 'standard', '# PRD 6 Blocked')`,
          [userId, primaryProject],
        ),
      ),
    ).rejects.toThrow(/Free tier monthly AI generation limit \(5\) reached/);

    // 5. Atomic Stripe reconciliation -> active Pro unlocks >10 documents; duplicate & stale events handled
    const reconcilePro = await pg.withAsRole('service_role', null, async (tx) => {
      const r1 = await tx.query<{
        out: { outcome: string; plan_tier: string; reconciliation_version: number };
      }>(
        `SELECT public.reconcile_stripe_subscription(
           'evt_pro_activate_1', 'customer.subscription.updated', 2000,
           $1::uuid, 'cus_123', 'sub_123', 'pro', 'active', 'monthly',
           now() + INTERVAL '30 days', true
         ) AS out`,
        [userId],
      );
      const dup = await tx.query<{ out: { outcome: string } }>(
        `SELECT public.reconcile_stripe_subscription(
           'evt_pro_activate_1', 'customer.subscription.updated', 2000,
           $1::uuid, 'cus_123', 'sub_123', 'pro', 'active', 'monthly',
           now() + INTERVAL '30 days', true
         ) AS out`,
        [userId],
      );
      const stale = await tx.query<{ out: { outcome: string; reconciliation_version: number } }>(
        `SELECT public.reconcile_stripe_subscription(
           'evt_older_non_live', 'customer.subscription.updated', 1500,
           $1::uuid, 'cus_123', 'sub_123', 'free', 'canceled', 'monthly',
           now(), false
         ) AS out`,
        [userId],
      );
      return { r1: r1.rows[0].out, dup: dup.rows[0].out, stale: stale.rows[0].out };
    });

    expect(reconcilePro.r1).toMatchObject({
      outcome: 'applied',
      plan_tier: 'pro',
      reconciliation_version: 1,
    });
    expect(reconcilePro.dup.outcome).toBe('duplicate_event');
    expect(reconcilePro.stale).toMatchObject({
      outcome: 'stale_event_ignored',
      reconciliation_version: 1,
    });

    // Pro user can now create Doc 11!
    await pg.withAsRole('authenticated', userId, (tx) =>
      tx.query(
        `INSERT INTO public.documents (id, user_id, project_id, title, content)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Doc 11 Pro', '')`,
        [randomUUID(), userId, primaryProject],
      ),
    );

    // 6. Decision A1: Stripe `past_due` fails closed -> plan_tier forced to 'free', Doc 12 blocked!
    const pastDueRes = await pg.withAsRole('service_role', null, async (tx) => {
      const r = await tx.query<{ out: { outcome: string; plan_tier: string; status: string } }>(
        `SELECT public.reconcile_stripe_subscription(
           'evt_past_due_2', 'invoice.payment_failed', 3000,
           $1::uuid, 'cus_123', 'sub_123', 'pro', 'past_due', 'monthly',
           now() + INTERVAL '30 days', true
         ) AS out`,
        [userId],
      );
      return r.rows[0].out;
    });
    expect(pastDueRes).toMatchObject({
      outcome: 'applied',
      plan_tier: 'free',
      status: 'past_due',
    });

    await expect(
      pg.withAsRole('authenticated', userId, (tx) =>
        tx.query(
          `INSERT INTO public.documents (id, user_id, project_id, title, content)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Doc 12 Blocked', '')`,
          [randomUUID(), userId, primaryProject],
        ),
      ),
    ).rejects.toThrow(/Free tier document limit \(10\) reached/);

    // 7. Active manual_grants overrides to Pro; setting revoked_at immediately re-enforces Free!
    await pg.withAsRole('service_role', null, (tx) =>
      tx.query(
        `INSERT INTO public.manual_grants (user_id, plan_tier, reason)
         VALUES ($1::uuid, 'pro', 'QA entitlement grant')`,
        [userId],
      ),
    );

    await pg.withAsRole('authenticated', userId, (tx) =>
      tx.query(
        `INSERT INTO public.documents (id, user_id, project_id, title, content)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Doc 12 Manual Grant', '')`,
        [randomUUID(), userId, primaryProject],
      ),
    );

    await pg.withAsRole('service_role', null, (tx) =>
      tx.query(`UPDATE public.manual_grants SET revoked_at = now() WHERE user_id = $1::uuid`, [
        userId,
      ]),
    );

    await expect(
      pg.withAsRole('authenticated', userId, (tx) =>
        tx.query(
          `INSERT INTO public.documents (id, user_id, project_id, title, content)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Doc 13 After Revoke', '')`,
          [randomUUID(), userId, primaryProject],
        ),
      ),
    ).rejects.toThrow(/Free tier document limit \(10\) reached/);
  });

  it('enforces strict cross-tenant RLS isolation and privilege boundaries across workspace, sync, and billing tables', async () => {
    const userA = await createTestUser(pg, 'tenant-a');
    const userB = await createTestUser(pg, 'tenant-b');
    const projB = randomUUID();
    const folderB = randomUUID();
    const docB = randomUUID();
    const designB = randomUUID();

    await pg.withAsRole('authenticated', userB, async (tx) => {
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'create', NULL, '{"name":"Secret B"}'::jsonb, NULL)`,
        [randomUUID(), userB, projB],
      );
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'workspace_folder', $3::uuid, 'create', $4::uuid, '{"name":"Folder B"}'::jsonb, NULL)`,
        [randomUUID(), userB, folderB, projB],
      );
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Secret Doc B","content":"confidential"}'::jsonb, NULL)`,
        [randomUUID(), userB, docB, projB],
      );
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'system_design', $3::uuid, 'create', $4::uuid, '{"name":"Secret Arch B"}'::jsonb, NULL)`,
        [randomUUID(), userB, designB, projB],
      );
    });

    await pg.withAsRole('service_role', null, (tx) =>
      tx.query(
        `INSERT INTO public.manual_grants (user_id, plan_tier, reason) VALUES ($1::uuid, 'pro', 'Tenant B grant')`,
        [userB],
      ),
    );

    // Tenant A cannot read, update, or delete any of Tenant B's records
    await pg.withAsRole('authenticated', userA, async (tx) => {
      for (const table of [
        'projects',
        'workspace_folders',
        'documents',
        'system_designs',
        'sync_changes',
        'subscriptions',
        'manual_grants',
      ]) {
        const res = await tx.query(`SELECT * FROM public.${table} WHERE user_id = $1::uuid`, [
          userB,
        ]);
        expect(res.rows).toHaveLength(0);
      }

      const updDoc = await tx.query(
        `UPDATE public.documents SET content = 'pwned' WHERE id = $1::uuid`,
        [docB],
      );
      expect(updDoc.rowCount).toBe(0);

      const delProj = await tx.query(`DELETE FROM public.projects WHERE id = $1::uuid`, [projB]);
      expect(delProj.rowCount).toBe(0);
    });

    // Authenticated user A cannot self-upgrade subscriptions, manual_grants, or call reconcile_stripe_subscription
    await expect(
      pg.withAsRole('authenticated', userA, (tx) =>
        tx.query(
          `INSERT INTO public.manual_grants (user_id, plan_tier) VALUES ($1::uuid, 'pro')`,
          [userA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const selfUpgradeAttempt = await pg.withAsRole('authenticated', userA, (tx) =>
      tx.query(`UPDATE public.subscriptions SET plan_tier = 'pro' WHERE user_id = $1::uuid`, [
        userA,
      ]),
    );
    expect(selfUpgradeAttempt.rowCount).toBe(0);

    await expect(
      pg.withAsRole('authenticated', userA, (tx) =>
        tx.query(
          `SELECT public.reconcile_stripe_subscription('evt_hack', 'customer.subscription.updated', 1, $1::uuid, 'c', 's', 'pro', 'active', 'monthly', now(), true)`,
          [userA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('serializes concurrent CAS updates, duplicate mutation_id retries, Free-tier quota inserts, and Stripe webhooks across parallel connections', async () => {
    const userId = await createTestUser(pg, 'concurrency-race-user');
    const projectId = randomUUID();
    const docId = randomUUID();

    await pg.withAsRole('authenticated', userId, async (tx) => {
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'create', NULL, '{"name":"Race Project"}'::jsonb, NULL)`,
        [randomUUID(), userId, projectId],
      );
      await tx.query(
        `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Race Doc","content":"v1"}'::jsonb, NULL)`,
        [randomUUID(), userId, docId, projectId],
      );
    });

    // 1. 5 parallel CAS updates all claiming p_base_version = 1 -> exactly 1 wins (v2), 4 conflict
    const casOutcomes = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        pg.withAsRole('authenticated', userId, async (tx) => {
          const r = await tx.query<{ res: { status: string; reason?: string; version?: number } }>(
            `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, $5::jsonb, 1) AS res`,
            [
              randomUUID(),
              userId,
              docId,
              projectId,
              JSON.stringify({ content: `writer-${idx}` }),
            ],
          );
          return r.rows[0].res;
        }),
      ),
    );

    const appliedCas = casOutcomes.filter((o) => o.status === 'applied');
    const conflictedCas = casOutcomes.filter(
      (o) => o.status === 'conflict' && o.reason === 'version_mismatch',
    );
    expect(appliedCas).toHaveLength(1);
    expect(appliedCas[0].version).toBe(2);
    expect(conflictedCas).toHaveLength(4);

    // 2. 4 parallel duplicate retries sharing the SAME p_mutation_id -> 1 applied, 3 already_processed
    const sharedMutationId = randomUUID();
    const retryOutcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        pg.withAsRole('authenticated', userId, async (tx) => {
          const r = await tx.query<{ res: { status: string; version: number } }>(
            `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"v3 idempotent"}'::jsonb, 2) AS res`,
            [sharedMutationId, userId, docId, projectId],
          );
          return r.rows[0].res;
        }),
      ),
    );

    expect(retryOutcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    expect(retryOutcomes.filter((o) => o.status === 'already_processed')).toHaveLength(3);

    // 3. Seed 7 additional documents (user now has 8 of 10 Free limit), then race 5 parallel creates -> max 2 succeed!
    await pg.withAsRole('authenticated', userId, async (tx) => {
      for (let i = 0; i < 7; i += 1) {
        await tx.query(
          `INSERT INTO public.documents (id, user_id, project_id, title, content)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '')`,
          [randomUUID(), userId, projectId, `Seed ${i}`],
        );
      }
    });

    const quotaRaceResults = await Promise.allSettled(
      Array.from({ length: 5 }, (_, idx) =>
        pg.withAsRole('authenticated', userId, (tx) =>
          tx.query(
            `INSERT INTO public.documents (id, user_id, project_id, title, content)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '')`,
            [randomUUID(), userId, projectId, `Concurrent Doc ${idx}`],
          ),
        ),
      ),
    );

    const quotaSucceeded = quotaRaceResults.filter((r) => r.status === 'fulfilled');
    const quotaRejected = quotaRaceResults.filter((r) => r.status === 'rejected');
    expect(quotaSucceeded).toHaveLength(2);
    expect(quotaRejected).toHaveLength(3);

    const finalDocCount = await pg.withAsRole('authenticated', userId, (tx) =>
      tx.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.documents WHERE user_id = $1::uuid AND deleted_at IS NULL`,
        [userId],
      ),
    );
    expect(Number(finalDocCount.rows[0].cnt)).toBe(10);

    // 4. 4 parallel duplicate Stripe webhook deliveries -> 1 applied, 3 duplicate_event
    const webhookRace = await Promise.all(
      Array.from({ length: 4 }, () =>
        pg.withAsRole('service_role', null, async (tx) => {
          const r = await tx.query<{ out: { outcome: string } }>(
            `SELECT public.reconcile_stripe_subscription(
               'evt_parallel_dup_1', 'invoice.paid', 5000,
               $1::uuid, 'cus_race', 'sub_race', 'pro', 'active', 'monthly',
               now() + INTERVAL '30 days', true
             ) AS out`,
            [userId],
          );
          return r.rows[0].out;
        }),
      ),
    );

    expect(webhookRace.filter((w) => w.outcome === 'applied')).toHaveLength(1);
    expect(webhookRace.filter((w) => w.outcome === 'duplicate_event')).toHaveLength(3);

    // 5. When backed by a multi-session TCP Pool (CI `postgres:17` / `supabase start`),
    //    prove deterministic lock blocking across overlapping uncommitted transactions!
    if (pg.isMultiSessionPool) {
      const overlapUser = await createTestUser(pg, 'overlap-lock-user');
      const overlapProj = randomUUID();
      const overlapDoc = randomUUID();

      await pg.withAsRole('authenticated', overlapUser, async (tx) => {
        await tx.query(
          `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'project', $3::uuid, 'create', NULL, '{"name":"Overlap Proj"}'::jsonb, NULL)`,
          [randomUUID(), overlapUser, overlapProj],
        );
        await tx.query(
          `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'create', $4::uuid, '{"title":"Overlap Doc","content":"v1"}'::jsonb, NULL)`,
          [randomUUID(), overlapUser, overlapDoc, overlapProj],
        );
      });

      let releaseTxA!: () => void;
      const holdTxAPromise = new Promise<void>((resolve) => {
        releaseTxA = resolve;
      });
      let notifyTxALocked!: () => void;
      const txALockedPromise = new Promise<void>((resolve) => {
        notifyTxALocked = resolve;
      });

      // Session A acquires row lock + advisory lock (v1 -> v2) and holds transaction open
      const sessionAPromise = pg.withAsRole('authenticated', overlapUser, async (tx) => {
        const res = await tx.query<{ res: { status: string; version: number } }>(
          `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"txA v2"}'::jsonb, 1) AS res`,
          [randomUUID(), overlapUser, overlapDoc, overlapProj],
        );
        notifyTxALocked();
        await holdTxAPromise;
        return res.rows[0].res;
      });

      await txALockedPromise;

      // Session B enters while Session A is STILL uncommitted -> must block on lock until A commits!
      let sessionBFinished = false;
      const sessionBPromise = pg
        .withAsRole('authenticated', overlapUser, async (tx) => {
          const res = await tx.query<{
            res: { status: string; reason: string; current_version: number };
          }>(
            `SELECT public.apply_sync_mutation($1::uuid, $2::uuid, 'document', $3::uuid, 'update', $4::uuid, '{"content":"txB stale"}'::jsonb, 1) AS res`,
            [randomUUID(), overlapUser, overlapDoc, overlapProj],
          );
          return res.rows[0].res;
        })
        .then((res) => {
          sessionBFinished = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 50));
      expect(sessionBFinished).toBe(false);

      // Release Session A -> commits v2 -> Session B unblocks and observes version_mismatch!
      releaseTxA();
      const [outA, outB] = await Promise.all([sessionAPromise, sessionBPromise]);
      expect(outA).toMatchObject({ status: 'applied', version: 2 });
      expect(outB).toMatchObject({
        status: 'conflict',
        reason: 'version_mismatch',
        current_version: 2,
      });
    }
  });
});
