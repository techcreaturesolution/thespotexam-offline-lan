import crypto from 'crypto';
import { Audit } from './audit';
import { Config } from './config';
import { Db, nowIso } from './db';
import { normalizeCode, randomToken, Sealer, sha256Hex, verifyScrypt } from './crypto';
import { ExamRow, PaperService } from './paper';
import { AttemptStatus, FINAL_STATUSES, HttpError, PaperQuestion } from './types';

export interface AttemptRow {
  exam_id: string; candidate_id: string; roll_number: string; status: AttemptStatus; machine_id: string | null; session_hash: string | null;
  login_at: string | null; started_at: string | null; submitted_at: string | null; last_seen_at: string | null;
  extra_seconds: number; disconnected_at_submit: number; idempotency_key: string;
}
export interface AnswerInput { questionId: string; answer?: unknown; flagged?: boolean; version: number; timeTakenSeconds?: number }

const MAX_TICK_MS = 5000;

const seededShuffle = <T>(items: T[], seed: string): T[] => {
  const out = [...items];
  let h = crypto.createHash('sha256').update(seed).digest();
  for (let i = out.length - 1; i > 0; i--) {
    if (i % 8 === 0) h = crypto.createHash('sha256').update(h).digest();
    const j = h.readUInt32BE((i % 8) * 4) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * Server-authoritative exam engine. Time is the persisted elapsed_ms of the exam, advanced only by this
 * process's monotonic clock while the exam is running — wall-clock changes on any PC (server included) have no effect.
 */
export class ExamEngine {
  private lastTick = process.hrtime.bigint();
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Db, private readonly paper: PaperService, private readonly audit: Audit, private readonly sealer: Sealer, private readonly cfg: Config) {}

  start() {
    for (const r of this.db.all<{ exam_id: string }>(`SELECT exam_id FROM exams WHERE state = 'running'`)) {
      this.audit.log('system', 'exam.recovered', r.exam_id, { note: 'Server restarted; timer resumed from last checkpoint' });
    }
    this.lastTick = process.hrtime.bigint();
    this.timer = setInterval(() => {
      const now = process.hrtime.bigint();
      const delta = Number((now - this.lastTick) / 1_000_000n);
      this.lastTick = now;
      this.tick(delta);
    }, 1000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  tick(deltaMs: number) {
    const d = Math.max(0, Math.min(deltaMs, MAX_TICK_MS));
    this.db.run(`UPDATE exams SET elapsed_ms = elapsed_ms + ? WHERE state = 'running'`, d);
    for (const r of this.db.all<{ exam_id: string }>(`SELECT exam_id FROM exams WHERE state = 'running'`)) this.sweep(r.exam_id);
  }

  // ───────── timing ─────────
  private durationSec(e: ExamRow) { return (e.duration_min || 0) * 60 + e.extra_seconds; }
  remainingSec(e: ExamRow, a?: Pick<AttemptRow, 'extra_seconds'>) {
    if (!e.started_at) return this.durationSec(e) + (a?.extra_seconds || 0);
    return Math.ceil(this.durationSec(e) + (a?.extra_seconds || 0) - e.elapsed_ms / 1000);
  }

  private sweep(examId: string) {
    const e = this.paper.exam(examId);
    const grace = this.cfg.autoSubmitGraceSeconds;
    const open = this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE exam_id = ? AND status = 'in_progress'`, examId);
    for (const a of open) {
      if (this.remainingSec(e, a) <= -grace) this.finalize(e, a, 'auto_submitted', 'system');
    }
    const maxExtra = this.db.get<{ m: number }>(`SELECT COALESCE(MAX(extra_seconds), 0) m FROM attempts WHERE exam_id = ?`, examId)!.m;
    if (this.remainingSec(e, { extra_seconds: maxExtra }) <= -grace) this.end(examId, 'system');
  }

  private finalize(e: ExamRow, a: AttemptRow, status: AttemptStatus, actor: string) {
    const disconnected = !a.last_seen_at || Date.now() - Date.parse(a.last_seen_at) > this.cfg.clientTimeoutSeconds * 1000 ? 1 : 0;
    this.db.run(`UPDATE attempts SET status = ?, submitted_at = ?, session_hash = CASE WHEN ? = 'submitted' THEN NULL ELSE session_hash END,
      disconnected_at_submit = ? WHERE exam_id = ? AND candidate_id = ?`, status, nowIso(), status, status === 'submitted' ? 0 : disconnected, e.exam_id, a.candidate_id);
    this.audit.log(actor, `attempt.${status}`, e.exam_id, { rollNumber: a.roll_number, elapsedMs: e.elapsed_ms });
  }

  // ───────── machines & candidate auth ─────────
  registerMachine(machineId: string, hostname: string, clientVersion: string, ip: string, existingToken?: string) {
    if (!/^[\w.:-]{6,128}$/.test(machineId)) throw new HttpError(400, 'Invalid machineId');
    const m = this.db.get<{ token_hash: string }>('SELECT token_hash FROM machines WHERE machine_id = ?', machineId);
    if (m && !(existingToken && sha256Hex(existingToken) === m.token_hash)) {
      throw new HttpError(409, 'Machine already registered; ask the invigilator to reset it');
    }
    const token = randomToken();
    this.db.run(`INSERT INTO machines (machine_id, token_hash, hostname, client_version, ip, registered_at, last_seen_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(machine_id) DO UPDATE SET token_hash = excluded.token_hash, hostname = excluded.hostname, client_version = excluded.client_version, ip = excluded.ip, last_seen_at = excluded.last_seen_at`,
      machineId, sha256Hex(token), hostname, clientVersion, ip, nowIso(), nowIso());
    this.audit.log(`machine:${machineId}`, m ? 'machine.reregistered' : 'machine.registered', null, { hostname, ip, clientVersion });
    return { machineToken: token };
  }

  authMachine(machineId?: string, token?: string, ip?: string) {
    if (!machineId || !token) throw new HttpError(401, 'Machine credentials required');
    const m = this.db.get<{ token_hash: string }>('SELECT token_hash FROM machines WHERE machine_id = ?', machineId);
    if (!m || m.token_hash !== sha256Hex(token)) throw new HttpError(401, 'Unknown machine; register first');
    this.db.run('UPDATE machines SET last_seen_at = ?, ip = COALESCE(?, ip) WHERE machine_id = ?', nowIso(), ip ?? null, machineId);
    return machineId;
  }

  resetMachine(machineId: string, actor: string) {
    this.db.run('DELETE FROM machines WHERE machine_id = ?', machineId);
    this.audit.log(actor, 'machine.reset', null, { machineId });
  }

  private activeExamFor(rollNumber: string): string {
    const rows = this.db.all<{ exam_id: string }>(`SELECT exam_id FROM exams WHERE state IN ('unlocked','running','paused')`);
    for (const r of rows) if (this.paper.paper(r.exam_id).candidates.some((c) => c.rollNumber === rollNumber)) return r.exam_id;
    throw new HttpError(401, 'Invalid roll number or password');
  }

  login(machineId: string, rollNumberIn: string, password: string, examIdIn?: string) {
    const rollNumber = String(rollNumberIn || '').trim().toUpperCase();
    if (!rollNumber || !password) throw new HttpError(400, 'rollNumber and password are required');
    const examId = examIdIn || this.activeExamFor(rollNumber);
    const e = this.paper.exam(examId);
    if (!['unlocked', 'running', 'paused'].includes(e.state)) throw new HttpError(423, 'Exam is not open for login yet');
    const p = this.paper.paper(examId);
    const c = p.candidates.find((x) => x.rollNumber === rollNumber);
    if (!c || !verifyScrypt(normalizeCode(password), c.passwordHash)) {
      this.audit.log(`machine:${machineId}`, 'auth.login_failed', examId, { rollNumber });
      throw new HttpError(401, 'Invalid roll number or password');
    }
    let a = this.db.get<AttemptRow>('SELECT * FROM attempts WHERE exam_id = ? AND candidate_id = ?', examId, c.id);
    if (a && FINAL_STATUSES.includes(a.status)) throw new HttpError(409, `Attempt already ${a.status}`);
    if (a?.machine_id && a.machine_id !== machineId) throw new HttpError(409, 'Candidate is bound to another PC; ask the invigilator to reset');
    const late = p.exam.settings.lateEntryMinutes;
    if (!a?.login_at && e.started_at && late > 0 && e.elapsed_ms > late * 60_000) throw new HttpError(403, 'Late entry window has closed');
    const other = this.db.get<{ roll_number: string }>(`SELECT roll_number FROM attempts WHERE exam_id = ? AND machine_id = ? AND candidate_id <> ? AND status IN ('not_started','in_progress')`, examId, machineId, c.id);
    if (other) throw new HttpError(409, `This PC is in use by ${other.roll_number}`);
    const token = randomToken();
    const status: AttemptStatus = a?.status || (e.started_at ? 'in_progress' : 'not_started');
    if (!a) {
      this.db.run(`INSERT INTO attempts (exam_id, candidate_id, roll_number, status, machine_id, session_hash, login_at, started_at, last_seen_at, idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, examId, c.id, rollNumber, status, machineId, sha256Hex(token), nowIso(), status === 'in_progress' ? nowIso() : null, nowIso(),
        `${p.center.code}:${examId}:${c.id}:${crypto.randomUUID()}`);
    } else {
      this.db.run('UPDATE attempts SET machine_id = ?, session_hash = ?, last_seen_at = ?, login_at = COALESCE(login_at, ?) WHERE exam_id = ? AND candidate_id = ?',
        machineId, sha256Hex(token), nowIso(), nowIso(), examId, c.id);
    }
    a = this.db.get<AttemptRow>('SELECT * FROM attempts WHERE exam_id = ? AND candidate_id = ?', examId, c.id)!;
    this.audit.log(`candidate:${rollNumber}`, 'auth.login', examId, { machineId });
    return { sessionToken: token, examId, candidate: { id: c.id, rollNumber, name: c.name, seatNumber: c.seatNumber, photo: c.photo }, state: this.state(examId, a) };
  }

  authCandidate(machineId: string, token?: string): AttemptRow {
    if (!token) throw new HttpError(401, 'Session required');
    const a = this.db.get<AttemptRow>('SELECT * FROM attempts WHERE session_hash = ?', sha256Hex(token));
    if (!a || a.machine_id !== machineId) throw new HttpError(401, 'Session expired; log in again');
    return a;
  }

  logout(a: AttemptRow) {
    this.db.run('UPDATE attempts SET session_hash = NULL WHERE exam_id = ? AND candidate_id = ?', a.exam_id, a.candidate_id);
    this.audit.log(`candidate:${a.roll_number}`, 'auth.logout', a.exam_id);
  }

  // ───────── candidate exam flow ─────────
  state(examId: string, aIn?: AttemptRow) {
    const e = this.paper.exam(examId);
    const a = aIn && this.db.get<AttemptRow>('SELECT * FROM attempts WHERE exam_id = ? AND candidate_id = ?', aIn.exam_id, aIn.candidate_id);
    return {
      examId, examState: e.state, title: e.title, serverTime: nowIso(),
      durationSeconds: this.durationSec(e) + (a?.extra_seconds || 0),
      remainingSeconds: Math.max(0, this.remainingSec(e, a)),
      attemptStatus: a?.status, paused: e.state === 'paused',
    };
  }

  private ensureStarted(e: ExamRow, a: AttemptRow): AttemptRow {
    if (a.status === 'not_started' && e.started_at) {
      this.db.run(`UPDATE attempts SET status = 'in_progress', started_at = ? WHERE exam_id = ? AND candidate_id = ?`, nowIso(), a.exam_id, a.candidate_id);
      this.audit.log(`candidate:${a.roll_number}`, 'attempt.started', a.exam_id);
      return { ...a, status: 'in_progress' };
    }
    return a;
  }

  questions(aIn: AttemptRow) {
    const e = this.paper.exam(aIn.exam_id);
    if (!e.started_at) throw new HttpError(423, 'Exam has not started');
    const a = this.ensureStarted(e, aIn);
    const p = this.paper.paper(a.exam_id);
    const byId = new Map(p.questions.map((q) => [q.id, q]));
    const seed = `${p.packageId}:${a.candidate_id}`;
    const sections = (p.exam.settings.randomizeSections ? seededShuffle(p.exam.sections, seed) : p.exam.sections).map((s) => {
      const ids = s.randomizeQuestions ? seededShuffle(s.questionIds, `${seed}:${s.index}`) : s.questionIds;
      return {
        index: s.index, name: s.name, description: s.description, marksPerQuestion: s.marksPerQuestion, negativeMarks: s.negativeMarks,
        questions: ids.map((id) => byId.get(id)).filter((q): q is PaperQuestion => !!q).map((q) => ({
          id: q.id, type: q.type, text: q.text, html: q.html, marks: q.marks, negativeMarks: q.negativeMarks, attachments: q.attachments,
          options: p.exam.settings.randomizeOptions ? seededShuffle(q.options, `${seed}:${q.id}`) : q.options,
        })),
      };
    });
    const answers = this.db.all<{ question_id: string; answer_json: string | null; flagged: number; version: number }>(
      'SELECT question_id, answer_json, flagged, version FROM answers WHERE exam_id = ? AND candidate_id = ?', a.exam_id, a.candidate_id)
      .map((r) => ({ questionId: r.question_id, answer: r.answer_json ? JSON.parse(r.answer_json) : null, flagged: !!r.flagged, version: r.version }));
    return { exam: { id: p.exam.id, title: p.exam.title, instructions: p.exam.instructions, allowReview: p.exam.settings.allowReview }, sections, answers, state: this.state(a.exam_id, a) };
  }

  private writeMode(e: ExamRow, a: AttemptRow): 'live' | 'late' {
    if (a.status === 'in_progress' && (e.state === 'running' || e.state === 'paused') && this.remainingSec(e, a) > -this.cfg.autoSubmitGraceSeconds) return 'live';
    if (a.status === 'auto_submitted' && a.disconnected_at_submit && a.submitted_at && Date.now() - Date.parse(a.submitted_at) < this.cfg.lateSyncWindowSeconds * 1000) return 'late';
    throw new HttpError(409, `Answers are closed (${a.status === 'in_progress' ? 'time over' : a.status})`);
  }

  saveAnswers(aIn: AttemptRow, answers: AnswerInput[]) {
    if (!Array.isArray(answers) || answers.length > 500) throw new HttpError(400, 'answers must be an array of at most 500 items');
    const e = this.paper.exam(aIn.exam_id);
    const a = this.ensureStarted(e, aIn);
    const mode = this.writeMode(e, a);
    const qIds = new Set(this.paper.paper(a.exam_id).questions.map((q) => q.id));
    const sec = new Map(this.paper.paper(a.exam_id).questions.map((q) => [q.id, q.sectionIndex]));
    const results: { questionId: string; version: number; status: 'saved' | 'stale' | 'invalid' }[] = [];
    this.db.tx(() => {
      for (const x of answers) {
        if (!x || !qIds.has(String(x.questionId)) || !Number.isInteger(x.version) || x.version < 1) { results.push({ questionId: String(x?.questionId), version: x?.version, status: 'invalid' }); continue; }
        const aj = x.answer === undefined || x.answer === null ? null : JSON.stringify(x.answer);
        if (aj && aj.length > 20000) { results.push({ questionId: x.questionId, version: x.version, status: 'invalid' }); continue; }
        const savedAt = nowIso();
        const mac = this.sealer.mac(a.exam_id, a.candidate_id, x.questionId, aj, !!x.flagged, x.version);
        const r = this.db.run(`INSERT INTO answers (exam_id, candidate_id, question_id, section_index, answer_json, flagged, version, time_taken_seconds, saved_at, late, row_mac)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(exam_id, candidate_id, question_id) DO UPDATE SET answer_json = excluded.answer_json, flagged = excluded.flagged,
          version = excluded.version, time_taken_seconds = excluded.time_taken_seconds, saved_at = excluded.saved_at, late = excluded.late, row_mac = excluded.row_mac
          WHERE excluded.version > answers.version`,
          a.exam_id, a.candidate_id, x.questionId, sec.get(x.questionId) ?? null, aj, x.flagged ? 1 : 0, x.version, x.timeTakenSeconds ?? null, savedAt, mode === 'late' ? 1 : 0, mac);
        results.push({ questionId: x.questionId, version: x.version, status: r.changes ? 'saved' : 'stale' });
      }
      this.db.run('UPDATE attempts SET last_seen_at = ? WHERE exam_id = ? AND candidate_id = ?', nowIso(), a.exam_id, a.candidate_id);
    });
    if (mode === 'late') this.audit.log(`candidate:${a.roll_number}`, 'answers.late_sync', a.exam_id, { count: results.filter((r) => r.status === 'saved').length });
    return { results, state: this.state(a.exam_id, a) };
  }

  submit(aIn: AttemptRow, answers?: AnswerInput[]) {
    if (answers?.length) this.saveAnswers(aIn, answers);
    const e = this.paper.exam(aIn.exam_id);
    const a = this.db.get<AttemptRow>('SELECT * FROM attempts WHERE exam_id = ? AND candidate_id = ?', aIn.exam_id, aIn.candidate_id)!;
    if (FINAL_STATUSES.includes(a.status)) return { status: a.status, submittedAt: a.submitted_at, alreadySubmitted: true };
    if (a.status !== 'in_progress') throw new HttpError(409, 'Exam has not started for this candidate');
    this.finalize(e, a, 'submitted', `candidate:${a.roll_number}`);
    return { status: 'submitted', submittedAt: nowIso(), alreadySubmitted: false };
  }

  logViolations(machineId: string, a: AttemptRow | null, items: { type: string; detail?: string; at?: string }[]) {
    const list = Array.isArray(items) ? items.slice(0, 100) : [];
    this.db.tx(() => {
      for (const v of list) {
        if (!v?.type) continue;
        this.db.run('INSERT INTO violations (exam_id, candidate_id, roll_number, machine_id, type, detail, client_at, at) VALUES (?,?,?,?,?,?,?,?)',
          a?.exam_id ?? null, a?.candidate_id ?? null, a?.roll_number ?? null, machineId, String(v.type).slice(0, 64), v.detail ? String(v.detail).slice(0, 500) : null, v.at ?? null, nowIso());
      }
    });
    return { logged: list.length };
  }

  heartbeat(a: AttemptRow) {
    this.db.run('UPDATE attempts SET last_seen_at = ? WHERE exam_id = ? AND candidate_id = ?', nowIso(), a.exam_id, a.candidate_id);
    return this.state(a.exam_id, a);
  }

  // ───────── admin controls ─────────
  startExam(examId: string, actor: string) {
    const e = this.paper.exam(examId);
    if (e.state !== 'unlocked') throw new HttpError(409, `Cannot start an exam that is ${e.state}`);
    this.db.tx(() => {
      this.db.run(`UPDATE exams SET state = 'running', started_at = ?, updated_at = ? WHERE exam_id = ?`, nowIso(), nowIso(), examId);
      this.db.run(`UPDATE attempts SET status = 'in_progress', started_at = ? WHERE exam_id = ? AND status = 'not_started' AND session_hash IS NOT NULL`, nowIso(), examId);
    });
    this.audit.log(actor, 'exam.started', examId);
    return this.state(examId);
  }

  pause(examId: string, actor: string, reason?: string) {
    const e = this.paper.exam(examId);
    if (e.state !== 'running') throw new HttpError(409, `Cannot pause an exam that is ${e.state}`);
    this.db.run(`UPDATE exams SET state = 'paused', paused_at = ? WHERE exam_id = ?`, nowIso(), examId);
    this.audit.log(actor, 'exam.paused', examId, { reason, elapsedMs: e.elapsed_ms });
    return this.state(examId);
  }

  resume(examId: string, actor: string) {
    const e = this.paper.exam(examId);
    if (e.state !== 'paused') throw new HttpError(409, `Cannot resume an exam that is ${e.state}`);
    this.db.run(`UPDATE exams SET state = 'running', paused_at = NULL WHERE exam_id = ?`, examId);
    this.audit.log(actor, 'exam.resumed', examId, { pausedSince: e.paused_at });
    return this.state(examId);
  }

  extend(examId: string, actor: string, minutes: number, rollNumber?: string, reason?: string) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 180) throw new HttpError(400, 'minutes must be between 1 and 180');
    const e = this.paper.exam(examId);
    if (!['unlocked', 'running', 'paused'].includes(e.state)) throw new HttpError(409, `Cannot extend an exam that is ${e.state}`);
    const secs = Math.round(minutes * 60);
    if (rollNumber) {
      const r = this.db.run(`UPDATE attempts SET extra_seconds = extra_seconds + ? WHERE exam_id = ? AND roll_number = ? AND status IN ('not_started','in_progress')`, secs, examId, rollNumber.toUpperCase());
      if (!r.changes) throw new HttpError(404, 'No open attempt for that roll number');
    } else {
      this.db.run('UPDATE exams SET extra_seconds = extra_seconds + ? WHERE exam_id = ?', secs, examId);
    }
    this.audit.log(actor, 'exam.extended', examId, { minutes, rollNumber, reason });
    return this.state(examId);
  }

  end(examId: string, actor: string) {
    const e = this.paper.exam(examId);
    if (e.state === 'ended') return this.state(examId);
    if (!['running', 'paused', 'unlocked'].includes(e.state)) throw new HttpError(409, `Cannot end an exam that is ${e.state}`);
    this.db.tx(() => {
      for (const a of this.db.all<AttemptRow>(`SELECT * FROM attempts WHERE exam_id = ? AND status = 'in_progress'`, examId)) this.finalize(e, a, actor === 'system' ? 'auto_submitted' : 'force_submitted', actor);
      this.db.run(`UPDATE attempts SET status = 'absent' WHERE exam_id = ? AND status = 'not_started'`, examId);
      const p = this.paper.paper(examId);
      for (const c of p.candidates) {
        this.db.run(`INSERT OR IGNORE INTO attempts (exam_id, candidate_id, roll_number, status, idempotency_key) VALUES (?,?,?,'absent',?)`,
          examId, c.id, c.rollNumber, `${p.center.code}:${examId}:${c.id}:${crypto.randomUUID()}`);
      }
      this.db.run(`UPDATE exams SET state = 'ended', ended_at = ?, updated_at = ? WHERE exam_id = ?`, nowIso(), nowIso(), examId);
    });
    this.audit.log(actor, 'exam.ended', examId, { elapsedMs: e.elapsed_ms });
    return this.state(examId);
  }

  /** Unbinds the candidate from their PC/session so they can log in elsewhere; `reopen` also reopens a submitted attempt. */
  resetCandidate(examId: string, rollNumber: string, actor: string, opts: { reopen?: boolean; reason?: string } = {}) {
    const a = this.db.get<AttemptRow>('SELECT * FROM attempts WHERE exam_id = ? AND roll_number = ?', examId, rollNumber.toUpperCase());
    if (!a) throw new HttpError(404, 'Candidate has not logged in');
    const reopen = !!opts.reopen && FINAL_STATUSES.includes(a.status) && a.status !== 'absent' && a.status !== 'disqualified';
    this.db.run(`UPDATE attempts SET machine_id = NULL, session_hash = NULL, status = CASE WHEN ? THEN 'in_progress' ELSE status END,
      submitted_at = CASE WHEN ? THEN NULL ELSE submitted_at END WHERE exam_id = ? AND candidate_id = ?`, reopen ? 1 : 0, reopen ? 1 : 0, examId, a.candidate_id);
    this.audit.log(actor, 'attempt.reset', examId, { rollNumber: a.roll_number, previousMachine: a.machine_id, reopened: reopen, reason: opts.reason });
    return { rollNumber: a.roll_number, reopened: reopen };
  }

  live(examId: string) {
    const e = this.paper.exam(examId);
    const p = e.sealed_paper_key ? this.paper.paper(examId) : null;
    const attempts = new Map(this.db.all<AttemptRow>('SELECT * FROM attempts WHERE exam_id = ?', examId).map((a) => [a.candidate_id, a]));
    const answered = new Map(this.db.all<{ candidate_id: string; n: number }>(`SELECT candidate_id, COUNT(*) n FROM answers WHERE exam_id = ? AND answer_json IS NOT NULL GROUP BY candidate_id`, examId).map((r) => [r.candidate_id, r.n]));
    const viol = new Map(this.db.all<{ candidate_id: string; n: number }>(`SELECT candidate_id, COUNT(*) n FROM violations WHERE exam_id = ? GROUP BY candidate_id`, examId).map((r) => [r.candidate_id, r.n]));
    const machines = new Map(this.db.all<{ machine_id: string; hostname: string; ip: string }>('SELECT machine_id, hostname, ip FROM machines').map((m) => [m.machine_id, m]));
    const timeout = this.cfg.clientTimeoutSeconds * 1000;
    const rows = (p?.candidates || []).map((c) => {
      const a = attempts.get(c.id);
      const stale = !a?.last_seen_at || Date.now() - Date.parse(a.last_seen_at) > timeout;
      const status = !a ? 'not_started' : a.status === 'in_progress' && stale ? 'disconnected' : a.status;
      const m = a?.machine_id ? machines.get(a.machine_id) : undefined;
      return {
        candidateId: c.id, rollNumber: c.rollNumber, name: c.name, seatNumber: c.seatNumber, status, loggedIn: !!a?.session_hash,
        machineId: a?.machine_id ?? null, hostname: m?.hostname ?? null, ip: m?.ip ?? null, lastSeenAt: a?.last_seen_at ?? null,
        answered: answered.get(c.id) || 0, totalQuestions: p?.questions.length || 0, violations: viol.get(c.id) || 0,
        remainingSeconds: Math.max(0, this.remainingSec(e, a)), extraSeconds: a?.extra_seconds || 0,
      };
    });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      exam: { examId, title: e.title, state: e.state, startedAt: e.started_at, elapsedSeconds: Math.floor(e.elapsed_ms / 1000), remainingSeconds: Math.max(0, this.remainingSec(e)), extraSeconds: e.extra_seconds },
      summary: { total: rows.length, notStarted: count('not_started'), inProgress: count('in_progress'), disconnected: count('disconnected'),
        submitted: rows.filter((r) => ['submitted', 'auto_submitted', 'force_submitted'].includes(r.status)).length, absent: count('absent') },
      candidates: rows,
    };
  }

  violations(examId?: string, sinceId = 0) {
    return examId
      ? this.db.all('SELECT * FROM violations WHERE exam_id = ? AND id > ? ORDER BY id DESC LIMIT 500', examId, sinceId)
      : this.db.all('SELECT * FROM violations WHERE id > ? ORDER BY id DESC LIMIT 500', sinceId);
  }

  /** Verifies MACs on every stored answer (detects edits made directly to the SQLite file). */
  verifyAnswers(examId: string) {
    const rows = this.db.all<{ candidate_id: string; question_id: string; answer_json: string | null; flagged: number; version: number; row_mac: string }>('SELECT * FROM answers WHERE exam_id = ?', examId);
    const bad = rows.filter((r) => r.row_mac !== this.sealer.mac(examId, r.candidate_id, r.question_id, r.answer_json, !!r.flagged, r.version));
    return { ok: bad.length === 0, checked: rows.length, tampered: bad.map((r) => ({ candidateId: r.candidate_id, questionId: r.question_id })) };
  }
}
