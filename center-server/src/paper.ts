import fs from 'fs';
import path from 'path';
import { Audit } from './audit';
import { CloudClient } from './cloud';
import { Db, nowIso } from './db';
import { decryptPackage, normalizeCode, Sealer, sha256Hex, unwrapKeyWithCode, verifyPackage, WrappedKey } from './crypto';
import { HttpError, PaperPayload } from './types';

export interface ExamRow {
  exam_id: string; title: string; scheduled_start: string; scheduled_end: string; duration_min: number;
  key_release_mode: 'otp' | 'online'; key_release_at: string; package_id: string | null; package_sha256: string | null;
  package_size: number | null; package_path: string | null; header_json: string | null; wrapped_key_json: string | null;
  state: string; state_message: string | null; sealed_paper_key: string | null; unlocked_at: string | null;
  started_at: string | null; paused_at: string | null; ended_at: string | null; elapsed_ms: number; extra_seconds: number;
}

/** Package lifecycle: download → verify → LOCKED on disk → unlock (OTP or online key) → decrypted in memory only. */
export class PaperService {
  private cache = new Map<string, PaperPayload>();
  /** Center-level fields sent with every status report (the cloud replaces its last report each time). */
  statusBase: () => Record<string, unknown> = () => ({});
  constructor(
    private readonly db: Db,
    private readonly sealer: Sealer,
    private readonly audit: Audit,
    private readonly cloud: CloudClient,
    private readonly dir: string,
    private readonly centerCode: () => string | undefined,
    private readonly cloudKey: () => string | undefined,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  exam(examId: string): ExamRow {
    const r = this.db.get<ExamRow>('SELECT * FROM exams WHERE exam_id = ?', examId);
    if (!r) throw new HttpError(404, 'Exam not found on this center');
    return r;
  }
  list(): ExamRow[] { return this.db.all<ExamRow>('SELECT * FROM exams ORDER BY scheduled_start'); }

  private setState(examId: string, state: string, message: string | null) {
    this.db.run(`UPDATE exams SET state = ?, state_message = ?, updated_at = ? WHERE exam_id = ?`, state, message, nowIso(), examId);
  }

  /** Pull the assigned exam list and download/verify any package that is missing or was rebuilt. */
  async sync(actor = 'system'): Promise<{ examId: string; state: string; message?: string }[]> {
    const exams = await this.cloud.exams();
    const out: { examId: string; state: string; message?: string }[] = [];
    for (const e of exams) {
      this.db.run(
        `INSERT INTO exams (exam_id, title, scheduled_start, scheduled_end, duration_min, key_release_mode, key_release_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(exam_id) DO UPDATE SET title=excluded.title, scheduled_start=excluded.scheduled_start,
         scheduled_end=excluded.scheduled_end, duration_min=excluded.duration_min, key_release_mode=excluded.key_release_mode,
         key_release_at=excluded.key_release_at`,
        e.examId, e.title, String(e.scheduledStart), String(e.scheduledEnd), e.totalDurationMinutes || 0, e.keyReleaseMode, String(e.keyReleaseAt),
      );
      const row = this.exam(e.examId);
      if (['unlocked', 'running', 'paused', 'ended'].includes(row.state)) { out.push({ examId: e.examId, state: row.state }); continue; }
      if (row.state === 'locked' && e.packageId && row.package_id === e.packageId) { out.push({ examId: e.examId, state: 'locked' }); continue; }
      try {
        await this.download(e.examId, actor);
        out.push({ examId: e.examId, state: 'locked' });
      } catch (err) {
        const message = (err as Error).message;
        this.setState(e.examId, 'failed', message);
        this.audit.log(actor, 'paper.download_failed', e.examId, { message });
        await this.report(e.examId, 'failed', undefined, message);
        out.push({ examId: e.examId, state: 'failed', message });
      }
    }
    return out;
  }

  async download(examId: string, actor: string) {
    const cloudKey = this.cloudKey();
    const centerCode = this.centerCode();
    if (!cloudKey || !centerCode) throw new HttpError(409, 'Center is not activated');
    const m = await this.cloud.manifest(examId);
    if (m.cloudPublicKey.trim() !== cloudKey.trim()) throw new Error('Cloud signing key differs from the key pinned at activation');
    this.setState(examId, 'downloading', null);
    await this.report(examId, 'downloading', m.packageId);
    const part = path.join(this.dir, `${m.packageId}.part`);
    await this.cloud.download(examId, part, m.size);
    const file = fs.readFileSync(part);
    if (file.length !== m.size || sha256Hex(file) !== m.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('Downloaded package hash does not match manifest');
    }
    const p = verifyPackage(file, cloudKey, { examId, centerCode, packageId: m.packageId });
    const final = path.join(this.dir, `${m.packageId}.tspkg`);
    fs.renameSync(part, final);
    const old = this.exam(examId).package_path;
    if (old && old !== final) fs.rmSync(old, { force: true });
    this.db.run(
      `UPDATE exams SET package_id=?, package_sha256=?, package_size=?, package_path=?, header_json=?, wrapped_key_json=?,
       key_release_mode=?, key_release_at=?, state='locked', state_message=?, updated_at=? WHERE exam_id=?`,
      m.packageId, m.sha256, m.size, final, p.headerBytes.toString('utf8'), m.wrappedKey ? JSON.stringify(m.wrappedKey) : null,
      m.keyReleaseMode, m.keyReleaseAt, 'Verified and locked', nowIso(), examId,
    );
    this.audit.log(actor, 'paper.downloaded', examId, { packageId: m.packageId, sha256: m.sha256, summary: p.header.summary });
    await this.report(examId, 'ready', m.packageId);
  }

  private async report(examId: string, paperStatus: string, packageId?: string, message?: string) {
    await this.cloud.status({ ...this.statusBase(), exams: [{ examId, paperStatus, packageId, message }] }).catch(() => undefined);
  }

  /** Re-reads the locked file and re-checks hash + signature (tamper detection on disk). */
  private loadVerified(row: ExamRow): Buffer {
    if (!row.package_path || !fs.existsSync(row.package_path)) throw new HttpError(409, 'Paper package is missing; re-download required');
    const file = fs.readFileSync(row.package_path);
    if (sha256Hex(file) !== row.package_sha256) throw new HttpError(409, 'Paper package on disk was modified; re-download required');
    verifyPackage(file, this.cloudKey()!, { examId: row.exam_id, centerCode: this.centerCode()!, packageId: row.package_id! });
    return file;
  }

  async unlock(examId: string, actor: string, releaseCode?: string): Promise<PaperPayload> {
    const row = this.exam(examId);
    if (row.state !== 'locked') throw new HttpError(409, `Exam is ${row.state}; only a locked paper can be unlocked`);
    const file = this.loadVerified(row);
    let key: Buffer;
    if (row.key_release_mode === 'otp') {
      if (!releaseCode) throw new HttpError(400, 'Release code is required');
      if (!row.wrapped_key_json) throw new HttpError(409, 'Package has no wrapped key');
      try {
        key = unwrapKeyWithCode(JSON.parse(row.wrapped_key_json) as WrappedKey, normalizeCode(releaseCode));
      } catch {
        this.audit.log(actor, 'paper.unlock_failed', examId, { reason: 'wrong release code' });
        throw new HttpError(403, 'Wrong release code');
      }
    } else {
      const r = await this.cloud.releaseKey(examId);
      if (r.packageId !== row.package_id) throw new HttpError(409, 'Cloud released a key for a different package');
      key = Buffer.from(r.paperKey, 'base64');
    }
    const payload = decryptPackage(file, key);
    this.db.run(`UPDATE exams SET sealed_paper_key=?, state='unlocked', unlocked_at=?, duration_min=?, state_message=NULL, updated_at=? WHERE exam_id=?`,
      this.sealer.seal(key.toString('base64')), nowIso(), payload.exam.totalDurationMinutes, nowIso(), examId);
    this.cache.set(examId, payload);
    this.audit.log(actor, 'paper.unlocked', examId, { mode: row.key_release_mode, packageId: row.package_id });
    return payload;
  }

  /** Decrypted paper for an unlocked exam; after a restart it is re-derived from the sealed key. */
  paper(examId: string): PaperPayload {
    const hit = this.cache.get(examId);
    if (hit) return hit;
    const row = this.exam(examId);
    if (!row.sealed_paper_key) throw new HttpError(423, 'Paper is locked');
    const payload = decryptPackage(this.loadVerified(row), Buffer.from(this.sealer.open(row.sealed_paper_key), 'base64'));
    this.cache.set(examId, payload);
    return payload;
  }
}
