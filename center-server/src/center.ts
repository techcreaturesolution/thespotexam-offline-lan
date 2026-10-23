import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { AttendanceService } from './attendance';
import { Audit } from './audit';
import { CloudClient } from './cloud';
import { Config } from './config';
import { generateKeyPair, randomToken, Sealer, sha256Hex, verifyScrypt } from './crypto';
import { Db, nowIso } from './db';
import { ExamEngine } from './engine';
import { PaperService } from './paper';
import { SyncEngine } from './sync';
import { HttpError } from './types';

export const hardwareFingerprint = () => {
  const macs = Object.values(os.networkInterfaces()).flat().filter((n) => n && !n.internal && n.mac !== '00:00:00:00:00:00').map((n) => n!.mac).sort();
  return sha256Hex(JSON.stringify({ host: os.hostname(), macs: [...new Set(macs)], cpu: os.cpus()[0]?.model, platform: os.platform(), arch: os.arch() }));
};

const hashAdminPassword = (pw: string) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$16384$8$1$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
};

/** Wires the Center Server together: activation state, pinned cloud key, paper service, exam engine, admin auth. */
export class Center {
  readonly db: Db;
  readonly sealer: Sealer;
  readonly audit: Audit;
  readonly cloud: CloudClient;
  readonly paper: PaperService;
  readonly engine: ExamEngine;
  readonly sync: SyncEngine;
  readonly attendance: AttendanceService;
  certFingerprint = '';
  private hb?: NodeJS.Timeout;

  constructor(readonly cfg: Config) {
    this.db = new Db(path.join(cfg.dataDir, 'center.db'));
    this.sealer = Sealer.fromFile(path.join(cfg.dataDir, 'master.key'));
    this.audit = new Audit(this.db);
    this.cloud = new CloudClient(cfg.cloudUrl, () => this.creds());
    this.paper = new PaperService(this.db, this.sealer, this.audit, this.cloud, path.join(cfg.dataDir, 'packages'), () => this.centerCode(), () => this.db.kvGet('cloud_public_key'));
    this.engine = new ExamEngine(this.db, this.paper, this.audit, this.sealer, cfg);
    this.attendance = new AttendanceService(this.db, this.paper, this.audit, this.sealer, cfg.requireAttendance);
    this.engine.loginGate = (examId, candidateId, rollNumber, machineId) => this.attendance.checkLogin(examId, candidateId, rollNumber, machineId);
    this.sync = new SyncEngine(this.db, this.cloud, this.paper, this.engine, this.audit, cfg, () => {
      const centerCode = this.db.kvGet('center_code');
      const privateKey = this.signingKey();
      const publicKey = this.db.kvGet('center_public_key');
      const cloudPublicKey = this.db.kvGet('cloud_public_key');
      return centerCode && privateKey && publicKey && cloudPublicKey ? { centerCode, privateKey, publicKey, cloudPublicKey } : null;
    });
    this.sync.attendance = this.attendance;
    this.paper.statusBase = () => this.statusBody();
  }

  centerCode() { return this.db.kvGet('center_code'); }
  creds() {
    const code = this.centerCode();
    const tok = this.db.kvGet('api_token_sealed');
    return code && tok ? { centerCode: code, apiToken: this.sealer.open(tok) } : null;
  }
  signingKey() {
    const s = this.db.kvGet('center_private_key_sealed');
    return s ? this.sealer.open(s) : null;
  }

  async activate(centerCode: string, activationKey: string, actor: string) {
    if (!centerCode || !activationKey) throw new HttpError(400, 'centerCode and activationKey are required');
    const kp = generateKeyPair();
    const r = await this.cloud.activate({ centerCode, activationKey, hardwareFingerprint: hardwareFingerprint(), publicKey: kp.publicKey, hostname: os.hostname(), appVersion: this.cfg.appVersion });
    this.db.tx(() => {
      this.db.kvSet('center_code', r.centerCode);
      this.db.kvSet('api_token_sealed', this.sealer.seal(r.apiToken));
      this.db.kvSet('center_private_key_sealed', this.sealer.seal(kp.privateKey));
      this.db.kvSet('center_public_key', kp.publicKey);
      this.db.kvSet('cloud_public_key', r.cloudPublicKey);
      this.db.kvSet('center_name', r.center?.name || '');
      this.db.kvSet('activated_at', nowIso());
    });
    this.audit.log(actor, 'center.activated', null, { centerCode: r.centerCode });
    return { centerCode: r.centerCode, centerName: r.center?.name };
  }

  status() {
    return {
      activated: !!this.creds(), centerCode: this.centerCode() || null, centerName: this.db.kvGet('center_name') || null,
      activatedAt: this.db.kvGet('activated_at') || null, lanIp: this.cfg.lanIp, port: this.cfg.port, tls: this.cfg.tls,
      certFingerprint: this.certFingerprint, appVersion: this.cfg.appVersion, adminConfigured: !!this.db.kvGet('admin_password_hash'),
      serverTime: nowIso(), exams: this.paper.list().map((e) => ({ examId: e.exam_id, title: e.title, state: e.state, message: e.state_message, scheduledStart: e.scheduled_start, keyReleaseMode: e.key_release_mode, keyReleaseAt: e.key_release_at, packageId: e.package_id })),
    };
  }

  connectedClients() {
    return this.db.get<{ n: number }>('SELECT COUNT(*) n FROM machines WHERE last_seen_at > ?', new Date(Date.now() - this.cfg.clientTimeoutSeconds * 1000).toISOString())!.n;
  }

  private statusBody() {
    const running = this.paper.list().find((e) => ['running', 'paused'].includes(e.state));
    return {
      appVersion: this.cfg.appVersion, hostname: os.hostname(), lanIp: this.cfg.lanIp, examState: running?.state || 'idle',
      connectedClients: this.connectedClients(), pendingSyncBatches: this.sync.pendingBatches(),
    };
  }

  async heartbeat() {
    if (!this.creds()) return;
    await this.cloud.status(this.statusBody());
  }

  startBackground() {
    this.engine.start();
    const beat = () => this.heartbeat().catch(() => undefined);
    beat();
    this.hb = setInterval(beat, this.cfg.heartbeatSeconds * 1000);
    this.sync.start();
  }
  stop() { this.engine.stop(); this.sync.stop(); if (this.hb) clearInterval(this.hb); this.db.close(); }

  // ───────── local admin auth ─────────
  setupAdmin(password: string, loopback: boolean) {
    if (this.db.kvGet('admin_password_hash')) throw new HttpError(409, 'Admin password already set');
    if (!loopback) throw new HttpError(403, 'Initial admin setup is only allowed on the server PC itself');
    if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    this.db.kvSet('admin_password_hash', hashAdminPassword(password));
    this.audit.log('admin', 'admin.password_set', null);
  }
  adminLogin(password: string, ip: string) {
    const h = this.db.kvGet('admin_password_hash');
    if (!h) throw new HttpError(409, 'Admin password not set; open the dashboard on the server PC');
    if (!password || !verifyScrypt(password, h)) { this.audit.log(`admin@${ip}`, 'admin.login_failed', null); throw new HttpError(401, 'Wrong password'); }
    const token = randomToken();
    this.db.run('DELETE FROM admin_sessions WHERE expires_at < ?', nowIso());
    this.db.run('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)', sha256Hex(token), new Date(Date.now() + 12 * 3600_000).toISOString());
    this.audit.log(`admin@${ip}`, 'admin.login', null);
    return { token, expiresInSeconds: 12 * 3600 };
  }
  authAdmin(token?: string) {
    if (!token || !this.db.get('SELECT 1 FROM admin_sessions WHERE token_hash = ? AND expires_at > ?', sha256Hex(token), nowIso())) throw new HttpError(401, 'Admin login required');
  }
}
