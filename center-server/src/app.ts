import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Center } from './center';
import { AttemptRow } from './engine';
import { HttpError } from './types';

type H = (req: Request, res: Response) => unknown;
const ok = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try { const data = await fn(req, res); if (!res.headersSent) res.json({ success: true, data }); } catch (e) { next(e); }
};
const bearer = (req: Request) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : undefined; };
const ip = (req: Request) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isLoopback = (req: Request) => ['127.0.0.1', '::1'].includes(ip(req));

export const createApp = (c: Center) => {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '2mb' }));

  const machine = (req: Request) => c.engine.authMachine(req.header('X-Machine-Id'), req.header('X-Machine-Token'), ip(req));
  const candidate = (req: Request): AttemptRow => c.engine.authCandidate(machine(req), bearer(req));
  const admin = (req: Request) => { c.authAdmin(bearer(req)); return `admin@${ip(req)}`; };
  const loginLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  // ───────── candidate client (LAN) ─────────
  app.get('/client/discover', ok(() => ({ service: 'thespot-center', centerCode: c.centerCode() || null, centerName: c.status().centerName, lanIp: c.cfg.lanIp, port: c.cfg.port, certFingerprint: c.certFingerprint, serverTime: new Date().toISOString(), appVersion: c.cfg.appVersion })));
  app.post('/client/register', ok((req) => c.engine.registerMachine(String(req.body?.machineId || ''), String(req.body?.hostname || '').slice(0, 100), String(req.body?.clientVersion || '').slice(0, 32), ip(req), req.header('X-Machine-Token'))));
  app.post('/auth/login', loginLimiter, ok((req) => c.engine.login(machine(req), req.body?.rollNumber, String(req.body?.password || ''), req.body?.examId)));
  app.post('/auth/logout', ok((req) => { c.engine.logout(candidate(req)); return {}; }));
  app.get('/exam/state', ok((req) => { const a = candidate(req); return c.engine.state(a.exam_id, a); }));
  app.get('/exam/questions', ok((req) => c.engine.questions(candidate(req))));
  app.post('/answers/save', ok((req) => c.engine.saveAnswers(candidate(req), req.body?.answers)));
  app.post('/exam/submit', ok((req) => c.engine.submit(candidate(req), req.body?.answers)));
  app.post('/violations/log', ok((req) => {
    const m = machine(req);
    let a: AttemptRow | null = null;
    try { a = c.engine.authCandidate(m, bearer(req)); } catch { a = null; }
    return c.engine.logViolations(m, a, req.body?.violations);
  }));
  app.post('/heartbeat', ok((req) => c.engine.heartbeat(candidate(req))));

  // ───────── local admin ─────────
  app.post('/admin/setup', ok((req) => { c.setupAdmin(String(req.body?.password || ''), isLoopback(req)); return {}; }));
  app.post('/admin/login', loginLimiter, ok((req) => c.adminLogin(String(req.body?.password || ''), ip(req))));
  app.get('/admin/status', ok((req) => { admin(req); return { ...c.status(), connectedClients: c.connectedClients() }; }));
  app.post('/admin/activate', ok((req) => c.activate(String(req.body?.centerCode || '').trim(), String(req.body?.activationKey || ''), admin(req))));
  app.post('/admin/sync-papers', ok((req) => c.paper.sync(admin(req))));
  app.post('/admin/exams/:examId/unlock', ok(async (req) => { const p = await c.paper.unlock(req.params.examId, admin(req), req.body?.releaseCode); return { examId: p.exam.id, candidates: p.candidates.length, questions: p.questions.length }; }));
  app.post('/admin/exams/:examId/start', ok((req) => c.engine.startExam(req.params.examId, admin(req))));
  app.post('/admin/exams/:examId/pause', ok((req) => c.engine.pause(req.params.examId, admin(req), req.body?.reason)));
  app.post('/admin/exams/:examId/resume', ok((req) => c.engine.resume(req.params.examId, admin(req))));
  app.post('/admin/exams/:examId/extend', ok((req) => c.engine.extend(req.params.examId, admin(req), Number(req.body?.minutes), req.body?.rollNumber, req.body?.reason)));
  app.post('/admin/exams/:examId/end', ok((req) => c.engine.end(req.params.examId, admin(req))));
  app.post('/admin/exams/:examId/reset-candidate', ok((req) => c.engine.resetCandidate(req.params.examId, String(req.body?.rollNumber || ''), admin(req), { reopen: !!req.body?.reopen, reason: req.body?.reason })));
  app.post('/admin/machines/:machineId/reset', ok((req) => { c.engine.resetMachine(req.params.machineId, admin(req)); return {}; }));
  app.get('/admin/exams/:examId/live', ok((req) => { admin(req); return c.engine.live(req.params.examId); }));
  app.get('/admin/exams/:examId/verify', ok((req) => { admin(req); return { answers: c.engine.verifyAnswers(req.params.examId), audit: c.audit.verify() }; }));
  app.get('/admin/violations', ok((req) => { admin(req); return c.engine.violations(req.query.examId as string | undefined, Number(req.query.sinceId || 0)); }));
  app.get('/admin/sync', ok((req) => { admin(req); return { pendingBatches: c.sync.pendingBatches(), exams: c.sync.status() }; }));
  app.post('/admin/sync/run', ok((req) => { admin(req); return c.sync.retryNow(); }));
  app.get('/admin/audit', ok((req) => { admin(req); return { entries: c.audit.list(Number(req.query.limit || 200), req.query.examId as string | undefined), chain: c.audit.verify() }; }));

  app.use((_req, res) => res.status(404).json({ success: false, message: 'Not found' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ success: false, message: status >= 500 && !(err instanceof HttpError) ? 'Internal error' : (err as Error).message });
  });
  return app;
};
