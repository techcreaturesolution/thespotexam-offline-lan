import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app';
import { Center } from '../src/center';
import { loadConfig } from '../src/config';
import { startMockCloud } from './mockCloud';

type Mock = Awaited<ReturnType<typeof startMockCloud>>;

describe('Center Server phase 2', () => {
  let cloud: Mock;
  let dir: string;
  let center: Center;
  let app: ReturnType<typeof createApp>;
  let adminTok = '';
  const m1 = { id: 'PC-LAB1-001', token: '' };
  const m2 = { id: 'PC-LAB1-002', token: '' };
  let s1 = '';
  let s2 = '';
  const boot = () => {
    center = new Center(loadConfig({ dataDir: dir, cloudUrl: cloud.url, tls: false, autoSubmitGraceSeconds: 5, clientTimeoutSeconds: 30 }));
    app = createApp(center);
  };
  const A = () => ({ Authorization: `Bearer ${adminTok}` });
  const C = (m: { id: string; token: string }, s?: string) => ({ 'X-Machine-Id': m.id, 'X-Machine-Token': m.token, ...(s ? { Authorization: `Bearer ${s}` } : {}) });

  before(async () => {
    cloud = await startMockCloud({ durationMinutes: 1 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'center-'));
    boot();
  });
  after(async () => { center.stop(); await cloud.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('admin setup is loopback-only and login works', async () => {
    assert.equal((await request(app).get('/admin/status')).status, 401);
    assert.equal((await request(app).post('/admin/setup').send({ password: 'Admin@12345' })).status, 200);
    assert.equal((await request(app).post('/admin/setup').send({ password: 'Other@12345' })).status, 409);
    assert.equal((await request(app).post('/admin/login').send({ password: 'wrong-pass' })).status, 401);
    adminTok = (await request(app).post('/admin/login').send({ password: 'Admin@12345' })).body.data.token;
    assert.ok(adminTok);
  });

  it('activates against cloud; wrong key rejected', async () => {
    assert.equal((await request(app).post('/admin/activate').set(A()).send({ centerCode: cloud.centerCode, activationKey: 'NOPE' })).status, 401);
    const r = await request(app).post('/admin/activate').set(A()).send({ centerCode: cloud.centerCode, activationKey: cloud.activationKey });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await request(app).get('/admin/status').set(A())).body.data.activated, true);
  });

  it('rejects a tampered package download, then downloads + verifies + locks', async () => {
    const bad = Buffer.from(cloud.file); bad[bad.length - 1] ^= 1;
    cloud.state.served = bad;
    const r1 = await request(app).post('/admin/sync-papers').set(A());
    assert.equal(r1.body.data[0].state, 'failed');
    assert.match(r1.body.data[0].message, /hash/);
    cloud.state.served = cloud.file;
    const r2 = await request(app).post('/admin/sync-papers').set(A());
    assert.equal(r2.body.data[0].state, 'locked');
    assert.ok(cloud.statusReports.some((s) => JSON.stringify(s).includes('"ready"')));
  });

  it('locked paper: no login, wrong release code rejected', async () => {
    m1.token = (await request(app).post('/client/register').send({ machineId: m1.id, hostname: 'lab1-001' })).body.data.machineToken;
    m2.token = (await request(app).post('/client/register').send({ machineId: m2.id, hostname: 'lab1-002' })).body.data.machineToken;
    assert.equal((await request(app).post('/client/register').send({ machineId: m1.id })).status, 409, 'hijack re-register blocked');
    assert.equal((await request(app).post('/auth/login').set(C(m1)).send({ rollNumber: 'R001', password: 'PASS-0001', examId: cloud.examId })).status, 423);
    assert.equal((await request(app).post(`/admin/exams/${cloud.examId}/unlock`).set(A()).send({ releaseCode: 'WRONG-CODE' })).status, 403);
  });

  it('unlocks with release code; candidate login; questions gated until start', async () => {
    const u = await request(app).post(`/admin/exams/${cloud.examId}/unlock`).set(A()).send({ releaseCode: cloud.releaseCode.toLowerCase() });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal((await request(app).post('/auth/login').set(C(m1)).send({ rollNumber: 'r001', password: 'bad' })).status, 401);
    const l = await request(app).post('/auth/login').set(C(m1)).send({ rollNumber: 'r001', password: 'pass-0001' });
    assert.equal(l.status, 200, JSON.stringify(l.body));
    s1 = l.body.data.sessionToken;
    assert.equal((await request(app).post('/auth/login').set(C(m2)).send({ rollNumber: 'R001', password: 'PASS-0001' })).status, 409, 'bound to other PC');
    assert.equal((await request(app).get('/exam/questions').set(C(m1, s1))).status, 423);
    assert.equal((await request(app).get('/exam/questions').set(C(m2, s1))).status, 401, 'session bound to machine');
  });

  it('start → questions without answer keys, versioned autosave', async () => {
    assert.equal((await request(app).post(`/admin/exams/${cloud.examId}/start`).set(A())).status, 200);
    const q = await request(app).get('/exam/questions').set(C(m1, s1));
    assert.equal(q.status, 200);
    assert.equal(q.body.data.sections[0].questions.length, 3);
    assert.ok(!JSON.stringify(q.body).match(/isCorrect|correctAnswer/));
    const save = await request(app).post('/answers/save').set(C(m1, s1)).send({ answers: [{ questionId: 'q1', answer: 2, version: 2 }, { questionId: 'q2', answer: 1, version: 1 }, { questionId: 'nope', answer: 1, version: 1 }] });
    assert.deepEqual(save.body.data.results.map((r: { status: string }) => r.status), ['saved', 'saved', 'invalid']);
    const stale = await request(app).post('/answers/save').set(C(m1, s1)).send({ answers: [{ questionId: 'q1', answer: 0, version: 1 }] });
    assert.equal(stale.body.data.results[0].status, 'stale');
  });

  it('timer is server-authoritative; pause stops it; extend adds time', async () => {
    center.engine.tick(4000); center.engine.tick(4000); center.engine.tick(2000);
    let st = (await request(app).get('/exam/state').set(C(m1, s1))).body.data;
    assert.equal(st.remainingSeconds, 50);
    await request(app).post(`/admin/exams/${cloud.examId}/pause`).set(A()).send({ reason: 'power' });
    center.engine.tick(5000);
    st = (await request(app).get('/exam/state').set(C(m1, s1))).body.data;
    assert.equal(st.remainingSeconds, 50);
    assert.equal(st.paused, true);
    center.engine.tick(60_000_000);
    await request(app).post(`/admin/exams/${cloud.examId}/resume`).set(A());
    center.engine.tick(60_000);
    st = (await request(app).get('/exam/state').set(C(m1, s1))).body.data;
    assert.equal(st.remainingSeconds, 45, 'huge tick is clamped to 5s');
    await request(app).post(`/admin/exams/${cloud.examId}/extend`).set(A()).send({ minutes: 2, rollNumber: 'R001', reason: 'PC swap' });
    st = (await request(app).get('/exam/state').set(C(m1, s1))).body.data;
    assert.equal(st.remainingSeconds, 165);
  });

  it('survives a server crash/restart with answers, session and time intact', async () => {
    const l2 = await request(app).post('/auth/login').set(C(m2)).send({ rollNumber: 'R002', password: 'PASS-0002' });
    s2 = l2.body.data.sessionToken;
    assert.equal(l2.body.data.state.attemptStatus, 'in_progress');
    center.stop();
    boot();
    const st = (await request(app).get('/exam/state').set(C(m1, s1))).body.data;
    assert.equal(st.examState, 'running');
    assert.equal(st.remainingSeconds, 165);
    const q = await request(app).get('/exam/questions').set(C(m1, s1));
    assert.equal(q.body.data.answers.find((a: { questionId: string }) => a.questionId === 'q1').answer, 2);
    adminTok = (await request(app).post('/admin/login').send({ password: 'Admin@12345' })).body.data.token;
  });

  it('auto-submits on timeout; candidate with extra time continues', async () => {
    let timeUpSubmit: { status: string } | undefined;
    for (let i = 0; i < 55; i++) {
      center.engine.tick(1000);
      if (timeUpSubmit) continue;
      const st = (await request(app).get('/exam/state').set(C(m2, s2))).body.data;
      if (st.attemptStatus === 'in_progress' && st.remainingSeconds <= 0) timeUpSubmit = (await request(app).post('/exam/submit').set(C(m2, s2)).send({})).body.data;
    }
    assert.equal(timeUpSubmit?.status, 'auto_submitted', 'a client submit after time-up is recorded as auto_submitted');
    const live = (await request(app).get(`/admin/exams/${cloud.examId}/live`).set(A())).body.data;
    const r2 = live.candidates.find((c: { rollNumber: string }) => c.rollNumber === 'R002');
    const r1 = live.candidates.find((c: { rollNumber: string }) => c.rollNumber === 'R001');
    assert.equal(r2.status, 'auto_submitted');
    assert.equal(r1.status, 'in_progress');
    assert.equal(live.exam.state, 'running');
    assert.equal((await request(app).post('/answers/save').set(C(m2, s2)).send({ answers: [{ questionId: 'q1', answer: 1, version: 1 }] })).status, 409);
  });

  it('logs violations and submits idempotently', async () => {
    const v = await request(app).post('/violations/log').set(C(m1, s1)).send({ violations: [{ type: 'focus_lost', detail: 'Alt+Tab' }, { type: 'blocked_key', detail: 'PrintScreen' }] });
    assert.equal(v.body.data.logged, 2);
    const s = await request(app).post('/exam/submit').set(C(m1, s1)).send({ answers: [{ questionId: 'q3', answer: 3, version: 1 }] });
    assert.equal(s.body.data.status, 'submitted');
    assert.equal((await request(app).get('/admin/violations').set(A())).body.data.length, 2);
  });

  it('end exam finalizes; reset/reopen is audited; tamper detection on DB rows and audit chain', async () => {
    const e = await request(app).post(`/admin/exams/${cloud.examId}/end`).set(A());
    assert.equal(e.body.data.examState, 'ended');
    let ver = (await request(app).get(`/admin/exams/${cloud.examId}/verify`).set(A())).body.data;
    assert.equal(ver.answers.ok, true);
    assert.equal(ver.audit.ok, true);
    center.db.run(`UPDATE answers SET answer_json = '0' WHERE question_id = 'q1'`);
    center.db.run(`UPDATE audit_log SET detail = '{}' WHERE action = 'exam.paused'`);
    ver = (await request(app).get(`/admin/exams/${cloud.examId}/verify`).set(A())).body.data;
    assert.equal(ver.answers.ok, false);
    assert.equal(ver.answers.tampered[0].questionId, 'q1');
    assert.equal(ver.audit.ok, false);
  });

  it('detects a modified package file on disk after restart', async () => {
    const pkg = fs.readdirSync(path.join(dir, 'packages')).find((f) => f.endsWith('.tspkg'))!;
    const p = path.join(dir, 'packages', pkg);
    const buf = fs.readFileSync(p); buf[buf.length - 5] ^= 1; fs.writeFileSync(p, buf);
    center.stop();
    boot();
    assert.throws(() => center.paper.paper(cloud.examId), /modified/);
  });
});
