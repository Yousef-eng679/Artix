import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');
const EXPAND_FILE = path.join(
  MIGRATIONS_DIR,
  '20261101100000_expand_sync_protocol_and_projects.sql',
);
const CONTRACT_FILE = path.join(
  MIGRATIONS_DIR,
  '20261101100100_contract_strict_cas_base_version.sql',
);

describe('C-01 / S-01 / S-03 / TASK-01A & TASK-01B: Expand/Contract Sync & CAS SQL Migrations', () => {
  it('1. provides Expand migration adding sync_changes.mutation_id, projects sync support, and structured conflict reasons', () => {
    expect(fs.existsSync(EXPAND_FILE)).toBe(true);
    const sql = fs.readFileSync(EXPAND_FILE, 'utf8');

    // sync_changes.mutation_id column & root-entity GUC scoping
    expect(sql).toMatch(/ALTER TABLE\s+public\.sync_changes[\s\S]*ADD COLUMN IF NOT EXISTS\s+mutation_id\s+UUID/i);
    expect(sql).toContain('artix.current_mutation_id');
    expect(sql).toContain('artix.current_mutation_entity_type');
    expect(sql).toContain('artix.current_mutation_entity_id');

    // projects table promoted to versioned syncable entity
    expect(sql).toMatch(/ALTER TABLE\s+public\.projects[\s\S]*ADD COLUMN IF NOT EXISTS\s+version\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1/i);
    expect(sql).toContain('trigger_increment_projects_version');
    expect(sql).toContain('trg_sync_changes_projects');
    expect(sql).toMatch(/'project',\s*'document',\s*'system_design',\s*'workspace_folder'/);

    // Structured conflict reasons for S-03 & multi-device recovery
    expect(sql).toContain("'reason', 'remote_deleted'");
    expect(sql).toContain("'reason', 'version_mismatch'");
    expect(sql).toContain("'reason', 'already_exists'");

    // Security advisor hardening preserved on record_sync_change()
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION\s+public\.record_sync_change\(\)\s+FROM\s+PUBLIC/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION\s+public\.record_sync_change\(\)\s+FROM\s+anon/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION\s+public\.record_sync_change\(\)\s+FROM\s+authenticated/i);
  });

  it('2. provides Contract migration removing null/<=0 CAS bypass and enforcing strict p_base_version >= 1 on update/delete', () => {
    expect(fs.existsSync(CONTRACT_FILE)).toBe(true);
    const sql = fs.readFileSync(CONTRACT_FILE, 'utf8');

    // Must explicitly reject missing or non-positive base versions on update/delete
    expect(sql).toMatch(/p_operation\s+IN\s*\(\s*'update'\s*,\s*'delete'\s*\)/i);
    expect(sql).toMatch(/p_base_version\s+IS\s+NULL\s+OR\s+p_base_version\s*<\s*1/i);
    expect(sql).toContain("ERRCODE = '22023'");

    // Must NOT contain any legacy null/<=0 CAS bypass predicate in WHERE clauses
    expect(sql).not.toMatch(/p_base_version\s+IS\s+NULL\s+OR\s+p_base_version\s*<=\s*0/i);

    // Must enforce exact version match across all 4 synced entity tables
    expect(sql).toMatch(/p\.version\s*=\s*p_base_version/);
    expect(sql).toMatch(/d\.version\s*=\s*p_base_version/);
    expect(sql).toMatch(/sd\.version\s*=\s*p_base_version/);
    expect(sql).toMatch(/wf\.version\s*=\s*p_base_version/);
  });
});
