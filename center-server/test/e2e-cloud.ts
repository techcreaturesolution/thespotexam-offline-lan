/**
 * Runs the Center Server against a real cloud backend. Fixture JSON (centerCode, activationKey, examId,
 * releaseCode, accessCodes, adminToken) comes from the cloud repo; usage:
 *   CLOUD_URL=http://localhost:5055/api/v1 FIXTURE=/path/fixture.json npx tsx test/e2e-cloud.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app';
import { Center } from '../src/center';
import { loadConfig } from '../src/config';

const fx = JSON.parse(fs.readFileSync(process.env.FIXTURE!, 'utf8'));
const cloudUrl = process.env.CLOUD_URL || 'http://localhost:5055/api/v1';
let failures = 0;
const check = (cond: unknown, label: string, extra?: unknown) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === undefined ? '' : ' ' + JSON.stringify(extra)}`); if (!cond) failures++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'center-e2e-'));
  const center = new Center(loadConfig({ dataDir: dir, cloudUrl, tls: false }));
  const app = createApp(center);
  await request(app).post('/admin/setup').send({ password: 'Admin@12345' });
  const A = { Authorization: `Bearer ${(await request(app).post('/admin/login').send({ password: 'Admin@12345' })).body.data.token}` };

  const act = await request(app).post('/admin/activate').set(A).send({ centerCode: fx.centerCode, activationKey: fx.activationKey });
  check(act.status === 200, 'activate against real cloud', act.body);
  const sync = await request(app).post('/admin/sync-papers').set(A);
  const mine = (sync.body.data || []).find((e: { examId: string }) => e.examId === fx.examId);
  check(mine?.state === 'locked', 'real package downloaded, signature + hashes verified, locked', sync.body);
  check((await request(app).post(`/admin/exams/${fx.examId}/unlock`).set(A).send({ releaseCode: 'AAAA-BBBB-CCCC' })).status === 403, 'wrong release code rejected');
  const un = await request(app).post(`/admin/exams/${fx.examId}/unlock`).set(A).send({ releaseCode: fx.releaseCode });
  check(un.status === 200 && un.body.data.candidates === fx.accessCodes.length, 'real OTP release code unwraps cloud key + decrypts', un.body);

  const mt = (await request(app).post('/client/register').send({ machineId: 'PC-E2E-0001', hostname: 'lab-pc-1' })).body.data.machineToken;
  const M = { 'X-Machine-Id': 'PC-E2E-0001', 'X-Machine-Token': mt };
  const c1 = fx.accessCodes[0];
  const login = await request(app).post('/auth/login').set(M).send({ rollNumber: c1.rollNumber, password: c1.accessCode });
  check(login.status === 200, 'candidate login with cloud-issued access code (scrypt hash from package)', login.body);
  const S = { ...M, Authorization: `Bearer ${login.body.data?.sessionToken}` };
  await request(app).post(`/admin/exams/${fx.examId}/start`).set(A);
  const q = await request(app).get('/exam/questions').set(S);
  const qs = q.body.data?.sections?.flatMap((s: { questions: unknown[] }) => s.questions) || [];
  check(q.status === 200 && qs.length === 3, 'questions served from decrypted cloud package', q.body);
  check(!JSON.stringify(q.body).includes('isCorrect'), 'no answer keys in questions');
  const save = await request(app).post('/answers/save').set(S).send({ answers: qs.map((x: { id: string }, i: number) => ({ questionId: x.id, answer: i === 2 ? [0, 2] : 1, version: 1 })) });
  check(save.body.data?.results?.every((r: { status: string }) => r.status === 'saved'), 'answers saved');
  check((await request(app).post('/exam/submit').set(S)).body.data?.status === 'submitted', 'submit');
  const end = await request(app).post(`/admin/exams/${fx.examId}/end`).set(A);
  const live = (await request(app).get(`/admin/exams/${fx.examId}/live`).set(A)).body.data;
  check(end.body.data?.examState === 'ended' && live.summary.submitted === 1 && live.summary.absent === fx.accessCodes.length - 1, 'end exam: 1 submitted, rest absent', live?.summary);

  const list = await fetch(`${cloudUrl}/offline-centers`, { headers: { Authorization: `Bearer ${fx.adminToken}` } }).then((r) => r.json());
  const row = (list.data || []).find((c: { centerCode: string }) => c.centerCode === fx.centerCode);
  const asg = row?.assignments?.find((a: { examId: unknown }) => JSON.stringify(a.exam).includes(fx.examId));
  check(row?.status === 'active' && asg?.paperStatus === 'ready', 'cloud admin shows center active + paper ready', { status: row?.status, paper: asg?.paperStatus });
  check(row?.lastReport?.hostname === os.hostname(), 'paper status report keeps center info on cloud');
  await center.heartbeat();
  const list2 = await fetch(`${cloudUrl}/offline-centers`, { headers: { Authorization: `Bearer ${fx.adminToken}` } }).then((r) => r.json());
  check((list2.data || []).find((c: { centerCode: string }) => c.centerCode === fx.centerCode)?.lastReport?.hostname === os.hostname(), 'heartbeat reaches cloud');

  const st = await center.sync.run({ force: true });
  const mineSync = st.find((x) => x.examId === fx.examId);
  check(mineSync?.status === 'synced' && mineSync.attempts.synced === fx.accessCodes.length, 'signed results uploaded, cloud ack verified, marked synced', mineSync);
  const again = await center.sync.retryNow();
  check(again.find((x) => x.examId === fx.examId)?.status === 'synced', 'second sync pass is a no-op');
  const b0 = center.db.get<{ payload: string; signature: string }>('SELECT payload, signature FROM sync_batches WHERE exam_id = ? ORDER BY batch_index', fx.examId)!;
  const replay = await center.cloud.uploadResults(b0.payload, b0.signature);
  check(replay.replayed === true, 'cloud replays the ack for a re-sent batch (no double count)');
  const forged = await center.cloud.uploadResults(b0.payload.replace('"submitted"', '"disqualified"'), b0.signature).then(() => null, (e: { status?: number }) => e.status);
  check(forged === 422 || forged === 400, 'cloud rejects a tampered result package', forged);
  const rec = await fetch(`${cloudUrl}/offline-centers/assignments/${fx.assignmentId}/reconciliation`, { headers: { Authorization: `Bearer ${fx.adminToken}` } }).then((r) => r.json());
  check(rec.data?.syncStatus === 'synced' && rec.data?.received === fx.accessCodes.length && rec.data?.submitted === 1 && rec.data?.missing === 0, 'cloud reconciliation counts match the center', rec.data);
  await center.heartbeat();
  const list3 = await fetch(`${cloudUrl}/offline-centers`, { headers: { Authorization: `Bearer ${fx.adminToken}` } }).then((r) => r.json());
  check((list3.data || []).find((c: { centerCode: string }) => c.centerCode === fx.centerCode)?.lastReport?.pendingSyncBatches === 0, 'heartbeat reports 0 pending sync batches');

  center.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
