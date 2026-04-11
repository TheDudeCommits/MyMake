import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { getEnv } from "@/lib/server/env";

let database: Database.Database | null = null;

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_zip_path TEXT NOT NULL,
    extracted_path TEXT NOT NULL,
    package_manager TEXT NOT NULL,
    status TEXT NOT NULL,
    current_revision_id TEXT,
    manifest_hash TEXT,
    preview_port INTEGER,
    last_opened_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_revision_id TEXT,
    label TEXT NOT NULL,
    source TEXT NOT NULL,
    snapshot_path TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversation_turns (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT,
    summary TEXT,
    ai_model_key TEXT,
    provider TEXT,
    edit_mode TEXT,
    selection_target_json TEXT,
    changed_files_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    context_snapshot_id TEXT,
    validation_result_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision_id TEXT,
    turn_id TEXT,
    token_budget INTEGER NOT NULL,
    primary_target TEXT,
    compressed_memory TEXT,
    sources_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS make_kits (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    summary TEXT NOT NULL,
    locked_rules_json TEXT NOT NULL,
    soft_rules_json TEXT NOT NULL,
    assets_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS validation_results (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision_id TEXT,
    turn_id TEXT,
    status TEXT NOT NULL,
    build_status TEXT NOT NULL,
    preview_status TEXT NOT NULL,
    selector_status TEXT NOT NULL,
    imports_status TEXT NOT NULL,
    design_status TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    details_json TEXT NOT NULL,
    raw_provider_output TEXT,
    retryable INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_projects_last_opened_at
    ON projects(last_opened_at DESC);

  CREATE INDEX IF NOT EXISTS idx_revisions_project_sequence
    ON revisions(project_id, sequence DESC);

  CREATE INDEX IF NOT EXISTS idx_attachments_project_created_at
    ON attachments(project_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_conversation_turns_project_created_at
    ON conversation_turns(project_id, created_at ASC);

  CREATE INDEX IF NOT EXISTS idx_context_snapshots_project_created_at
    ON context_snapshots(project_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_make_kits_project_priority
    ON make_kits(project_id, priority DESC, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_validation_results_project_created_at
    ON validation_results(project_id, created_at DESC);
`;

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function runMigrations(db: Database.Database): void {
  ensureColumn(db, "projects", "last_opened_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "projects", "created_at", "TEXT NOT NULL DEFAULT ''");
}

export function getDb(): Database.Database {
  if (database) {
    return database;
  }

  const dbPath = getEnv().databasePath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.exec(SCHEMA_SQL);
  runMigrations(database);

  return database;
}
