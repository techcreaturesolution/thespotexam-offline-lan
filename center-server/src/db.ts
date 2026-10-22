import { DatabaseSync, SQLInputValue } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exams (
  exam_id TEXT PRIMARY KEY, title TEXT, scheduled_start TEXT, scheduled_end TEXT, duration_min INTEGER,
  key_release_mode TEXT, key_release_at TEXT, package_id TEXT, package_sha256 TEXT, package_size INTEGER,
  package_path TEXT, header_json TEXT, wrapped_key_json TEXT,
  state TEXT NOT NULL DEFAULT 'not_downloaded', state_message TEXT,
  sealed_paper_key TEXT, unlocked_at TEXT, started_at TEXT, paused_at TEXT, ended_at TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0, extra_seconds INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS machines (
  machine_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, hostname TEXT, client_version TEXT, ip TEXT,
  registered_at TEXT NOT NULL, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  exam_id TEXT NOT NULL, candidate_id TEXT NOT NULL, roll_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started', machine_id TEXT, session_hash TEXT,
  login_at TEXT, started_at TEXT, submitted_at TEXT, last_seen_at TEXT,
  extra_seconds INTEGER NOT NULL DEFAULT 0, disconnected_at_submit INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL, row_mac TEXT,
  PRIMARY KEY (exam_id, candidate_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_roll ON attempts(exam_id, roll_number);
CREATE INDEX IF NOT EXISTS attempts_session ON attempts(session_hash);
CREATE TABLE IF NOT EXISTS answers (
  exam_id TEXT NOT NULL, candidate_id TEXT NOT NULL, question_id TEXT NOT NULL, section_index INTEGER,
  answer_json TEXT, flagged INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, time_taken_seconds INTEGER,
  saved_at TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0, row_mac TEXT,
  PRIMARY KEY (exam_id, candidate_id, question_id)
);
CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id TEXT, candidate_id TEXT, roll_number TEXT, machine_id TEXT,
  type TEXT NOT NULL, detail TEXT, client_at TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  exam_id TEXT, detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
`;

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

/** SQLite in WAL mode with synchronous=FULL so every committed write survives a crash or power loss. */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
  }

  run(sql: string, ...p: Param[]) { return this.raw.prepare(sql).run(...p); }
  get<T = Row>(sql: string, ...p: Param[]): T | undefined { return this.raw.prepare(sql).get(...p) as T | undefined; }
  all<T = Row>(sql: string, ...p: Param[]): T[] { return this.raw.prepare(sql).all(...p) as T[]; }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  kvGet(k: string): string | undefined { return this.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', k)?.v; }
  kvSet(k: string, v: string) { this.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v); }
  kvDel(k: string) { this.run('DELETE FROM kv WHERE k = ?', k); }
  close() { this.raw.close(); }
}

export const nowIso = () => new Date().toISOString();
