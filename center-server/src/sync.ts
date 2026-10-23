import crypto from 'crypto';
import { Audit } from './audit';
import { CloudClient } from './cloud';
import { ed25519Sign, ed25519Verify, sha256Hex } from './crypto';
import { Db, nowIso } from './db';
import { ExamEngine } from './engine';
import { PaperService } from './paper';
import { Config } from './config';
import { FINAL_STATUSES, HttpError } from './types';

export const SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_exams (
  exam_id TEXT PRIMARY KEY, status TEXT NOT NULL, message TEXT, built_at TEXT, synced_at TEXT, purged_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_batches (
  batch_id TEXT PRIMARY KEY, exam_id TEXT NOT NULL, batch_index INTEGER NOT NULL, is_final INTEGER NOT NULL,
  payload TEXT NOT NULL, signature TEXT NOT NULL, payload_sha256 TEXT NOT NULL, attempt_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', tries INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, last_error TEXT,
  ack TEXT, ack_signature TEXT, acked_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_batches_exam ON sync_batches(exam_id, batch_index);
CREATE TABLE IF NOT EXISTS sync_attempts (
  exam_id TEXT NOT NULL, candidate_id TEXT NOT NULL, batch_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', reason TEXT, PRIMARY KEY (exam_id, candidate_id)
);
`;

interface BatchRow {
  batch_id: string; exam_id: string; batch_index: number; is_final: number; payload: string; signature: string; payload_sha256: string;
  attempt_count: number; status: 'pending' | 'acked' | 'error'; tries: number; next_try_at: string | null; last_error: string | null;
  ack: string | null; acked_at: string | null;
}
interface AckBody {
  batchId: string; examId: string; centerCode: string; payloadSha256: string; accepted: number; duplicates: number; rejected: number;
  attempts: { idempotencyKey: string; status: 'accepted' | 'duplicate' | 'rejected'; reason?: string }[];
}

/**
 * Uploads finalised results to the cloud. Batches are built once (exact payload bytes + center signature persisted), so every
 * retry after a crash, timeout or lost ack resends identical content and the cloud replays its ack instead of double-counting.
 * An exam/attempt is "synced" only after a cloud-signed ack is verified.
 */
export class SyncEngine {
  attendance?: { forSync(examId: string): Map<string, unknown>; purge(examId: string): void };
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: Db, private readonly cloud: CloudClient, private readonly paper: PaperService, private readonly engine: ExamEngine,
    private readonly audit: Audit, private readonly cfg: Config,
    private readonly keys: () => { centerCode: string; privateKey: string; publicKey: string; cloudPublicKey: string } | null,
  ) {
    db.raw.exec(SYNC_SCHEMA);
  }

  start() { this.timer = setInterval(() => this.run().catch(() => undefined), this.cfg.syncIntervalSeconds * 1000); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); }

  pendingBatches() { return this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM sync_batches WHERE status != 'acked'`)!.n; }

  /** One pass: build batches for exams that are ready, upload due batches, purge old synced data. */
  async run(opts: { force?: boolean } = {}) {
    if (this.running) return this.status();
    this.running = true;
    try {
      if (!this.keys()) return this.status();
      for (const e of this.paper.list().filter((x) => x.state === 'ended')) this.build(e.exam_id);
      const due = this.db.all<BatchRow>(
        `SELECT * FROM sync_batches WHERE status = 'pending' ${opts.force ? '' : 'AND (next_try_at IS NULL OR next_try_at <= ?)'} ORDER BY exam_id, batch_index`,
        ...(opts.force ? [] : [nowIso()]));
      if (due.length && (await this.cloud.online())) {
        for (const b of due) if (!(await this.upload(b))) break;
      }
      this.purge();
      return this.status();
    } finally {
      this.running = false;
    }
  }

  /** Re-queues batches in 'error' (after the operator fixed the cause) and runs immediately. */
  async retryNow() {
    this.db.run(`UPDATE sync_batches SET status = 'pending', next_try_at = NULL WHERE status = 'error'`);
    return this.run({ force: true });
  }

  private setExam(examId: string, status: string, message: string | null = null) {
    this.db.run(`INSERT INTO sync_exams (exam_id, status, message) VALUES (?,?,?) ON CONFLICT(exam_id) DO UPDATE SET status = excluded.status, message = excluded.message`, examId, status, message);
  }

  /** Builds all batches for an ended exam once every attempt is final and no late sync can still change it. */
  build(examId: string): boolean {
    const se = this.db.get<{ status: string; built_at: string | null }>('SELECT * FROM sync_exams WHERE exam_id = ?', examId);
    if (se?.built_at) return false;
    const k = this.keys()!;
    const e = this.paper.exam(examId);
    const attempts = this.db.all<Record<string, string | number | null>>('SELECT * FROM attempts WHERE exam_id = ? ORDER BY roll_number', examId);
    const lateUntil = Math.max(0, ...attempts.filter((a) => a.status === 'auto_submitted' && a.disconnected_at_submit && a.submitted_at)
      .map((a) => Date.parse(String(a.submitted_at)) + this.cfg.lateSyncWindowSeconds * 1000));
    if (attempts.some((a) => !FINAL_STATUSES.includes(a.status as never)) || lateUntil > Date.now()) {
      this.setExam(examId, 'waiting', lateUntil > Date.now() ? `Waiting for late sync until ${new Date(lateUntil).toISOString()}` : 'Attempts still open');
      return false;
    }
    const ver = this.engine.verifyAnswers(examId);
    const chain = this.audit.verify();
    if (!ver.ok || !chain.ok) {
      const message = !ver.ok ? `Local DB tamper detected in ${ver.tampered.length} answer row(s); upload blocked` : 'Audit log chain broken; upload blocked';
      if (se?.status !== 'blocked') this.audit.log('system', 'sync.blocked', examId, { message });
      this.setExam(examId, 'blocked', message);
      return false;
    }
    const answers = this.db.all<Record<string, string | number | null>>('SELECT * FROM answers WHERE exam_id = ?', examId);
    const viol = this.db.all<Record<string, string | null>>('SELECT * FROM violations WHERE exam_id = ? ORDER BY id', examId);
    const durSec = (e.duration_min || 0) * 60 + e.extra_seconds;
    const att = this.attendance?.forSync(examId);
    const items = attempts.map((a) => ({
      idempotencyKey: String(a.idempotency_key), candidateId: String(a.candidate_id), rollNumber: String(a.roll_number), status: String(a.status),
      startedAt: a.started_at ?? undefined, submittedAt: a.submitted_at ?? undefined,
      timeUsedSeconds: a.started_at ? Math.min(Math.floor(e.elapsed_ms / 1000), durSec + Number(a.extra_seconds)) : 0,
      extraTimeSeconds: Number(a.extra_seconds), machineId: a.machine_id ?? undefined,
      answers: answers.filter((x) => x.candidate_id === a.candidate_id).map((x) => ({
        questionId: String(x.question_id), sectionIndex: Number(x.section_index ?? 0), answer: x.answer_json == null ? null : JSON.parse(String(x.answer_json)),
        flagged: !!x.flagged, version: Number(x.version), savedAt: String(x.saved_at), timeTakenSeconds: x.time_taken_seconds == null ? undefined : Number(x.time_taken_seconds), late: !!x.late,
      })),
      violations: viol.filter((v) => v.candidate_id === a.candidate_id).map((v) => ({ type: String(v.type), detail: v.detail ?? undefined, at: String(v.at) })),
      attendance: att?.get(String(a.candidate_id)),
    }));
    const summary = {
      expected: attempts.length, attempts: attempts.length,
      submitted: attempts.filter((a) => ['submitted', 'auto_submitted', 'force_submitted'].includes(String(a.status))).length,
      absent: attempts.filter((a) => a.status === 'absent').length,
    };
    const size = Math.max(1, Math.min(this.cfg.syncBatchSize, 100));
    const chunks: (typeof items)[] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    if (!chunks.length) chunks.push([]);
    this.db.tx(() => {
      chunks.forEach((chunk, i) => {
        const batchId = `${k.centerCode}:${examId}:${crypto.randomUUID()}`;
        const isFinal = i === chunks.length - 1;
        const payload = JSON.stringify({ formatVersion: 1, batchId, centerCode: k.centerCode, examId, packageId: e.package_id ?? undefined, batchIndex: i, isFinal, createdAt: nowIso(), ...(isFinal ? { summary } : {}), attempts: chunk });
        this.db.run(`INSERT INTO sync_batches (batch_id, exam_id, batch_index, is_final, payload, signature, payload_sha256, attempt_count, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          batchId, examId, i, isFinal ? 1 : 0, payload, ed25519Sign(k.privateKey, payload), sha256Hex(payload), chunk.length, nowIso());
        for (const at of chunk) this.db.run('INSERT OR REPLACE INTO sync_attempts (exam_id, candidate_id, batch_id, idempotency_key) VALUES (?,?,?,?)', examId, at.candidateId, batchId, at.idempotencyKey);
      });
      this.db.run(`INSERT INTO sync_exams (exam_id, status, built_at) VALUES (?, 'pending', ?) ON CONFLICT(exam_id) DO UPDATE SET status = 'pending', message = NULL, built_at = excluded.built_at`, examId, nowIso());
    });
    this.audit.log('system', 'sync.batches_built', examId, { batches: chunks.length, attempts: items.length, summary });
    return true;
  }

  private backoff(tries: number) {
    const base = Math.min(this.cfg.syncBackoffMaxSeconds, this.cfg.syncBackoffBaseSeconds * 2 ** Math.max(0, tries - 1));
    return new Date(Date.now() + Math.round(base * (0.8 + Math.random() * 0.4) * 1000)).toISOString();
  }

  /** Returns false when the cloud looks unreachable, so the pass stops early. */
  private async upload(b: BatchRow): Promise<boolean> {
    const k = this.keys()!;
    if (sha256Hex(b.payload) !== b.payload_sha256 || !ed25519Verify(k.publicKey, b.payload, b.signature)) {
      this.fail(b, 'Stored batch no longer matches its signature (local tamper); not uploaded', true);
      return true;
    }
    let res: { ack: string; signature: string; replayed?: boolean };
    try {
      res = await this.cloud.uploadResults(b.payload, b.signature);
    } catch (err) {
      const status = (err as HttpError).status || 0;
      const permanent = status >= 400 && status < 500 && ![401, 408, 429].includes(status);
      this.fail(b, (err as Error).message, permanent);
      const reachable = permanent || (status >= 400 && status < 500);
      if (!reachable) {
        const next = this.db.get<{ next_try_at: string }>('SELECT next_try_at FROM sync_batches WHERE batch_id = ?', b.batch_id)!.next_try_at;
        this.db.run(`UPDATE sync_batches SET next_try_at = ? WHERE status = 'pending' AND (next_try_at IS NULL OR next_try_at < ?)`, next, next);
      }
      return reachable;
    }
    let ack: AckBody;
    try {
      if (!ed25519Verify(k.cloudPublicKey, res.ack, res.signature)) throw new Error('Ack signature invalid');
      ack = JSON.parse(res.ack);
      if (ack.batchId !== b.batch_id || ack.payloadSha256 !== b.payload_sha256 || ack.centerCode !== k.centerCode) throw new Error('Ack does not match the uploaded batch');
    } catch (err) {
      this.fail(b, (err as Error).message, false);
      return true;
    }
    this.db.tx(() => {
      this.db.run(`UPDATE sync_batches SET status = 'acked', ack = ?, ack_signature = ?, acked_at = ?, last_error = NULL, tries = tries + 1 WHERE batch_id = ?`, res.ack, res.signature, nowIso(), b.batch_id);
      for (const r of ack.attempts) {
        this.db.run('UPDATE sync_attempts SET status = ?, reason = ? WHERE batch_id = ? AND idempotency_key = ?', r.status === 'rejected' ? 'rejected' : 'synced', r.reason ?? null, b.batch_id, r.idempotencyKey);
      }
      const left = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM sync_batches WHERE exam_id = ? AND status != 'acked'`, b.exam_id)!.n;
      const rejected = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM sync_attempts WHERE exam_id = ? AND status = 'rejected'`, b.exam_id)!.n;
      if (!left) {
        this.db.run('UPDATE sync_exams SET status = ?, message = ?, synced_at = ? WHERE exam_id = ?', rejected ? 'synced_with_rejections' : 'synced',
          rejected ? `${rejected} attempt(s) rejected by the cloud` : null, nowIso(), b.exam_id);
      } else this.setExam(b.exam_id, 'in_progress');
    });
    this.audit.log('system', 'sync.batch_acked', b.exam_id, { batchId: b.batch_id, accepted: ack.accepted, duplicates: ack.duplicates, rejected: ack.rejected, replayed: !!res.replayed });
    return true;
  }

  private fail(b: BatchRow, message: string, permanent: boolean) {
    this.db.run(`UPDATE sync_batches SET tries = tries + 1, last_error = ?, status = ?, next_try_at = ? WHERE batch_id = ?`,
      message.slice(0, 500), permanent ? 'error' : 'pending', permanent ? null : this.backoff(b.tries + 1), b.batch_id);
    if (permanent) { this.setExam(b.exam_id, 'error', message.slice(0, 500)); this.audit.log('system', 'sync.batch_error', b.exam_id, { batchId: b.batch_id, message }); }
  }

  /** Deletes candidate data (answers, attempts, violations, package file) for exams fully synced more than retentionDays ago. */
  purge(now = Date.now()) {
    const cutoff = new Date(now - this.cfg.retentionDays * 86400_000).toISOString();
    for (const s of this.db.all<{ exam_id: string }>(`SELECT exam_id FROM sync_exams WHERE status = 'synced' AND purged_at IS NULL AND synced_at < ?`, cutoff)) {
      this.db.tx(() => {
        for (const t of ['answers', 'violations', 'attempts', 'sync_attempts']) this.db.run(`DELETE FROM ${t} WHERE exam_id = ?`, s.exam_id);
        this.db.run(`UPDATE sync_batches SET payload = '', signature = '' WHERE exam_id = ?`, s.exam_id);
        this.attendance?.purge(s.exam_id);
        this.db.run('UPDATE sync_exams SET purged_at = ? WHERE exam_id = ?', nowIso(), s.exam_id);
      });
      this.paper.purge(s.exam_id);
      this.audit.log('system', 'sync.purged', s.exam_id, { retentionDays: this.cfg.retentionDays });
    }
  }

  status() {
    const exams = this.db.all<Record<string, unknown>>('SELECT * FROM sync_exams ORDER BY exam_id');
    return exams.map((x) => {
      const id = String(x.exam_id);
      const b = this.db.all<BatchRow>('SELECT batch_id, batch_index, status, tries, next_try_at, last_error, attempt_count, acked_at, ack FROM sync_batches WHERE exam_id = ? ORDER BY batch_index', id);
      const acks = b.filter((r) => r.ack).map((r) => JSON.parse(r.ack!) as AckBody);
      const cnt = (s: string) => this.db.get<{ n: number }>('SELECT COUNT(*) n FROM sync_attempts WHERE exam_id = ? AND status = ?', id, s)!.n;
      return {
        examId: id, status: x.status, message: x.message, builtAt: x.built_at, syncedAt: x.synced_at, purgedAt: x.purged_at,
        attempts: { pending: cnt('pending'), synced: cnt('synced'), rejected: cnt('rejected') },
        cloud: { accepted: acks.reduce((s, a) => s + a.accepted, 0), duplicates: acks.reduce((s, a) => s + a.duplicates, 0), rejected: acks.reduce((s, a) => s + a.rejected, 0) },
        batches: b.map((r) => ({ batchId: r.batch_id, index: r.batch_index, status: r.status, attempts: r.attempt_count, tries: r.tries, nextTryAt: r.next_try_at, lastError: r.last_error, ackedAt: r.acked_at })),
      };
    });
  }
}
