import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import type { Integration } from './types.js';

function rowToIntegration(row: {
  id: string;
  kind: string;
  name: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}): Integration {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    config = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listIntegrations(): Integration[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM integrations ORDER BY created_at ASC')
    .all() as Parameters<typeof rowToIntegration>[0][];
  return rows.map(rowToIntegration);
}

export function getIntegration(id: string): Integration | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM integrations WHERE id = ?')
    .get(id) as Parameters<typeof rowToIntegration>[0] | undefined;
  if (!row) return undefined;
  return rowToIntegration(row);
}

export function createIntegration(kind: string, name: string, config: unknown): Integration {
  const db = getDb();
  const id = nanoid(12);
  const configJson = JSON.stringify(config);
  db.prepare(
    `INSERT INTO integrations (id, kind, name, config_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).run(id, kind, name, configJson);
  return getIntegration(id)!;
}

export interface IntegrationPatch {
  name?: string;
  config?: unknown;
  enabled?: boolean;
}

export function updateIntegration(id: string, patch: IntegrationPatch): Integration | undefined {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.config !== undefined) {
    fields.push('config_json = ?');
    values.push(JSON.stringify(patch.config));
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }

  if (fields.length === 0) return getIntegration(id);

  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE integrations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getIntegration(id);
}

export function deleteIntegration(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
}

export function setEnabled(id: string, enabled: boolean): Integration | undefined {
  return updateIntegration(id, { enabled });
}
