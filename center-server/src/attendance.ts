import { Audit } from './audit';
import { Sealer } from './crypto';
import { Db, nowIso } from './db';
import { PaperService } from './paper';
import { HttpError } from './types';

export const ATTENDANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS attendance (
  exam_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  roll_number TEXT NOT NULL,
  status TEXT NOT NULL,
  method TEXT,
  verified_by TEXT,
  verified_at TEXT,
  photo_matched INTEGER,
  match_score REAL,
  override_reason TEXT,
  live_photo_sealed TEXT,
  fingerprint_sealed TEXT,
  fingerprint_format TEXT,
  machine_id TEXT,
  allocated_by TEXT,
  allocated_at TEXT,
  PRIMARY KEY (exam_id, candidate_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_machine ON attendance(exam_id, machine_id) WHERE machine_id IS NOT NULL;
`;

const METHODS = ['photo', 'fingerprint', 'face', 'photo_fingerprint', 'manual_override'] as const;
type Method = (typeof METHODS)[number];
const MAX_BIOMETRIC_CHARS = 1_500_000;

interface Row {
  exam_id: string; candidate_id: string; roll_number: string; status: string; method: string | null; verified_by: string | null; verified_at: string | null;
  photo_matched: number | null; match_score: number | null; override_reason: string | null; live_photo_sealed: string | null; fingerprint_sealed: string | null;
  fingerprint_format: string | null; machine_id: string | null; allocated_by: string | null; allocated_at: string | null;
}

export interface MarkInput {
  status?: 'present' | 'absent';
  method?: string;
  photoMatched?: boolean;
  matchScore?: number;
  livePhoto?: string;
  fingerprintTemplate?: string;
  fingerprintFormat?: string;
  overrideReason?: string;
}

export class AttendanceService {
  constructor(private readonly db: Db, private readonly paper: PaperService, private readonly audit: Audit, private readonly sealer: Sealer, private readonly requireAttendance: boolean) {
    db.raw.exec(ATTENDANCE_SCHEMA);
  }

  private row(examId: string, candidateId: string) {
    return this.db.get<Row>('SELECT * FROM attendance WHERE exam_id = ? AND candidate_id = ?', examId, candidateId);
  }

  private candidate(examId: string, rollNumber: string) {
    const roll = String(rollNumber || '').trim().toUpperCase();
    const c = this.paper.paper(examId).candidates.find((x) => x.rollNumber === roll);
    if (!c) throw new HttpError(404, `Roll number ${roll} is not in this exam`);
    return c;
  }

  private attemptStarted(examId: string, candidateId: string) {
    return !!this.db.get('SELECT 1 FROM attempts WHERE exam_id = ? AND candidate_id = ? AND login_at IS NOT NULL', examId, candidateId);
  }

  list(examId: string) {
    const p = this.paper.paper(examId);
    const rows = new Map(this.db.all<Row>('SELECT * FROM attendance WHERE exam_id = ?', examId).map((r) => [r.candidate_id, r]));
    const machines = new Map(this.db.all<{ machine_id: string; hostname: string | null; ip: string | null; last_seen_at: string | null }>('SELECT machine_id, hostname, ip, last_seen_at FROM machines').map((m) => [m.machine_id, m]));
    const candidates = p.candidates.map((c) => {
      const r = rows.get(c.id);
      const m = r?.machine_id ? machines.get(r.machine_id) : undefined;
      return {
        candidateId: c.id, rollNumber: c.rollNumber, name: c.name, gender: c.gender ?? null, seatNumber: c.seatNumber, photo: c.photo ?? null,
        attendance: r?.status || 'pending', method: r?.method ?? null, verifiedBy: r?.verified_by ?? null, verifiedAt: r?.verified_at ?? null,
        photoMatched: r?.photo_matched == null ? null : !!r.photo_matched, fingerprintCaptured: !!r?.fingerprint_sealed, overrideReason: r?.override_reason ?? null,
        machineId: r?.machine_id ?? null, hostname: m?.hostname ?? null, allocatedAt: r?.allocated_at ?? null,
      };
    });
    const allocated = new Set(candidates.map((c) => c.machineId).filter(Boolean));
    const timeoutMs = 60_000;
    const freeMachines = [...machines.values()]
      .filter((m) => !allocated.has(m.machine_id))
      .map((m) => ({ machineId: m.machine_id, hostname: m.hostname, ip: m.ip, online: !!m.last_seen_at && Date.now() - Date.parse(m.last_seen_at) < timeoutMs }))
      .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
    return {
      requireAttendance: this.requireAttendance,
      summary: { total: candidates.length, present: candidates.filter((c) => c.attendance === 'present').length, absent: candidates.filter((c) => c.attendance === 'absent').length, allocated: allocated.size },
      candidates, freeMachines,
    };
  }

  mark(examId: string, rollNumber: string, input: MarkInput, actor: string) {
    const c = this.candidate(examId, rollNumber);
    const status = input.status || 'present';
    if (!['present', 'absent'].includes(status)) throw new HttpError(400, 'status must be present or absent');
    if (status === 'absent' && this.attemptStarted(examId, c.id)) throw new HttpError(409, 'Candidate has already logged in; cannot mark absent');
    const method = (input.method || 'photo') as Method;
    if (status === 'present' && !METHODS.includes(method)) throw new HttpError(400, `method must be one of ${METHODS.join(', ')}`);
    if (status === 'present' && method === 'manual_override' && !String(input.overrideReason || '').trim()) throw new HttpError(400, 'overrideReason is required for a manual override');
    if (status === 'present' && method === 'photo' && input.photoMatched !== true) throw new HttpError(400, 'Confirm the live photo matches the registered photo, or use a manual override with a reason');
    for (const [k, v] of [['livePhoto', input.livePhoto], ['fingerprintTemplate', input.fingerprintTemplate]] as const) {
      if (v !== undefined && (typeof v !== 'string' || v.length > MAX_BIOMETRIC_CHARS)) throw new HttpError(400, `${k} must be a base64 string under ${MAX_BIOMETRIC_CHARS} chars`);
    }
    if (method.includes('fingerprint') && status === 'present' && !input.fingerprintTemplate) throw new HttpError(400, 'fingerprintTemplate is required for fingerprint verification');
    const existing = this.row(examId, c.id);
    const seal = (v?: string) => (v ? this.sealer.seal(v) : null);
    this.db.run(`INSERT INTO attendance (exam_id, candidate_id, roll_number, status, method, verified_by, verified_at, photo_matched, match_score, override_reason, live_photo_sealed, fingerprint_sealed, fingerprint_format, machine_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(exam_id, candidate_id) DO UPDATE SET status = excluded.status, method = excluded.method, verified_by = excluded.verified_by, verified_at = excluded.verified_at,
        photo_matched = excluded.photo_matched, match_score = excluded.match_score, override_reason = excluded.override_reason,
        live_photo_sealed = COALESCE(excluded.live_photo_sealed, attendance.live_photo_sealed), fingerprint_sealed = COALESCE(excluded.fingerprint_sealed, attendance.fingerprint_sealed),
        fingerprint_format = COALESCE(excluded.fingerprint_format, attendance.fingerprint_format),
        machine_id = CASE WHEN excluded.status = 'present' THEN attendance.machine_id ELSE NULL END`,
      examId, c.id, c.rollNumber, status, status === 'present' ? method : null, actor, nowIso(),
      input.photoMatched === undefined ? null : input.photoMatched ? 1 : 0, Number.isFinite(input.matchScore) ? Number(input.matchScore) : null,
      input.overrideReason ? String(input.overrideReason).slice(0, 500) : null, seal(input.livePhoto), seal(input.fingerprintTemplate),
      input.fingerprintFormat ? String(input.fingerprintFormat).slice(0, 40) : null);
    this.audit.log(actor, status === 'present' ? 'attendance.present' : 'attendance.absent', examId, {
      rollNumber: c.rollNumber, method, photoMatched: input.photoMatched, overrideReason: input.overrideReason, fingerprint: !!input.fingerprintTemplate, livePhoto: !!input.livePhoto, previous: existing?.status,
    });
    return this.list(examId).candidates.find((x) => x.candidateId === c.id);
  }

  allocate(examId: string, rollNumber: string, machineIdIn: string | undefined, actor: string) {
    const c = this.candidate(examId, rollNumber);
    const r = this.row(examId, c.id);
    if (r?.status !== 'present') throw new HttpError(409, 'Mark the candidate present before allocating a PC');
    if (this.attemptStarted(examId, c.id)) throw new HttpError(409, 'Candidate has already logged in; reset the candidate to move them to another PC');
    let machineId = machineIdIn ? String(machineIdIn) : undefined;
    if (!machineId) {
      machineId = this.list(examId).freeMachines.find((m) => m.online)?.machineId;
      if (!machineId) throw new HttpError(409, 'No free online PC to allocate');
    }
    if (!this.db.get('SELECT 1 FROM machines WHERE machine_id = ?', machineId)) throw new HttpError(404, 'Unknown PC');
    const taken = this.db.get<{ roll_number: string }>('SELECT roll_number FROM attendance WHERE exam_id = ? AND machine_id = ? AND candidate_id <> ?', examId, machineId, c.id);
    if (taken) throw new HttpError(409, `PC already allocated to ${taken.roll_number}`);
    const inUse = this.db.get<{ roll_number: string }>(`SELECT roll_number FROM attempts WHERE exam_id = ? AND machine_id = ? AND candidate_id <> ? AND status IN ('not_started','in_progress')`, examId, machineId, c.id);
    if (inUse) throw new HttpError(409, `PC is in use by ${inUse.roll_number}`);
    this.db.run('UPDATE attendance SET machine_id = ?, allocated_by = ?, allocated_at = ? WHERE exam_id = ? AND candidate_id = ?', machineId, actor, nowIso(), examId, c.id);
    this.audit.log(actor, 'attendance.allocated', examId, { rollNumber: c.rollNumber, machineId, previous: r.machine_id });
    return this.list(examId).candidates.find((x) => x.candidateId === c.id);
  }

  release(examId: string, rollNumber: string, actor: string) {
    const c = this.candidate(examId, rollNumber);
    const r = this.row(examId, c.id);
    if (!r?.machine_id) return {};
    if (this.attemptStarted(examId, c.id)) throw new HttpError(409, 'Candidate has already logged in; reset the candidate first');
    this.db.run('UPDATE attendance SET machine_id = NULL, allocated_by = NULL, allocated_at = NULL WHERE exam_id = ? AND candidate_id = ?', examId, c.id);
    this.audit.log(actor, 'attendance.released', examId, { rollNumber: c.rollNumber, machineId: r.machine_id });
    return {};
  }

  /** What the candidate PC shows on its login screen. */
  assignment(machineId: string) {
    const r = this.db.get<Row>(`SELECT a.* FROM attendance a JOIN exams e ON e.exam_id = a.exam_id
      WHERE a.machine_id = ? AND e.state IN ('unlocked','running','paused') ORDER BY a.allocated_at DESC LIMIT 1`, machineId);
    if (!r) return { assigned: false, requireAttendance: this.requireAttendance };
    const c = this.paper.paper(r.exam_id).candidates.find((x) => x.id === r.candidate_id);
    return {
      assigned: true, requireAttendance: this.requireAttendance, examId: r.exam_id,
      candidate: c ? { rollNumber: c.rollNumber, name: c.name, seatNumber: c.seatNumber, photo: c.photo ?? null } : { rollNumber: r.roll_number },
    };
  }

  /** Called by the exam engine before a candidate login on a PC. */
  checkLogin(examId: string, candidateId: string, rollNumber: string, machineId: string) {
    const mine = this.row(examId, candidateId);
    const onPc = this.db.get<{ roll_number: string; candidate_id: string }>('SELECT roll_number, candidate_id FROM attendance WHERE exam_id = ? AND machine_id = ?', examId, machineId);
    if (onPc && onPc.candidate_id !== candidateId) throw new HttpError(403, `This PC is allocated to ${onPc.roll_number}`);
    if (mine?.status === 'absent') throw new HttpError(403, `${rollNumber} is marked absent; see the attendance desk`);
    if (mine?.machine_id && mine.machine_id !== machineId) throw new HttpError(403, 'You are allocated to a different PC; see the attendance desk');
    if (this.requireAttendance && (mine?.status !== 'present' || !mine.machine_id)) throw new HttpError(403, 'Complete attendance and PC allocation at the attendance desk first');
  }

  /** Attendance evidence included in the result upload (no raw biometric data). */
  forSync(examId: string) {
    return new Map(this.db.all<Row>('SELECT * FROM attendance WHERE exam_id = ?', examId).map((r) => [r.candidate_id, {
      status: r.status, method: r.method ?? undefined, verifiedBy: r.verified_by ?? undefined, verifiedAt: r.verified_at ?? undefined,
      photoMatched: r.photo_matched == null ? undefined : !!r.photo_matched, matchScore: r.match_score ?? undefined, overrideReason: r.override_reason ?? undefined,
      fingerprintCaptured: !!r.fingerprint_sealed, livePhotoCaptured: !!r.live_photo_sealed, allocatedMachineId: r.machine_id ?? undefined, allocatedAt: r.allocated_at ?? undefined,
    }]));
  }

  purge(examId: string) {
    this.db.run('DELETE FROM attendance WHERE exam_id = ?', examId);
  }
}
