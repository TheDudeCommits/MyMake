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

  CREATE INDEX IF NOT EXISTS idx_projects_last_opened_at
    ON projects(last_opened_at DESC);

  CREATE INDEX IF NOT EXISTS idx_revisions_project_sequence
    ON revisions(project_id, sequence DESC);

  CREATE INDEX IF NOT EXISTS idx_attachments_project_created_at
    ON attachments(project_id, created_at DESC);
`;

export function getDb(): Database.Database {
  if (database) {
    return database;
  }

  const dbPath = getEnv().databasePath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.exec(SCHEMA_SQL);

  return database;
}
