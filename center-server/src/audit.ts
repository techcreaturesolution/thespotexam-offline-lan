import { Db, nowIso } from './db';
import { sha256Hex } from './crypto';

const GENESIS = '0'.repeat(64);

/** Append-only, hash-chained audit log; any edited/deleted row breaks verify(). */
export class Audit {
  constructor(private readonly db: Db) {}

  log(actor: string, action: string, examId: string | null, detail?: unknown) {
    this.db.tx(() => {
      const prev = this.db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')?.hash || GENESIS;
      const at = nowIso();
      const d = detail === undefined ? null : JSON.stringify(detail);
      const hash = sha256Hex([prev, at, actor, action, examId ?? '', d ?? ''].join('|'));
      this.db.run('INSERT INTO audit_log (at, actor, action, exam_id, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?)', at, actor, action, examId, d, prev, hash);
    });
  }

  list(limit = 200, examId?: string) {
    return examId
      ? this.db.all('SELECT * FROM audit_log WHERE exam_id = ? ORDER BY id DESC LIMIT ?', examId, limit)
      : this.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
  }

  verify(): { ok: boolean; count: number; brokenAt?: number } {
    let prev = GENESIS;
    const rows = this.db.all<{ id: number; at: string; actor: string; action: string; exam_id: string | null; detail: string | null; prev_hash: string; hash: string }>('SELECT * FROM audit_log ORDER BY id');
    for (const r of rows) {
      const h = sha256Hex([prev, r.at, r.actor, r.action, r.exam_id ?? '', r.detail ?? ''].join('|'));
      if (r.prev_hash !== prev || r.hash !== h) return { ok: false, count: rows.length, brokenAt: r.id };
      prev = r.hash;
    }
    return { ok: true, count: rows.length };
  }
}
