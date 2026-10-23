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

describe('Center Server phase 5: attendance and PC allocation', () => {
  let cloud: Mock;
  let dir: string;
  let center: Center;
  let app: ReturnType<typeof createApp>;
  let A: Record<string, string>;
  const pcs: Record<string, Record<string, string>> = {};
  const base = () => `/admin/exams/${cloud.examId}`;
  const login = (pc: string, rollNumber: string, password: string) => request(app).post('/auth/login').set(pcs[pc]).send({ rollNumber, password });
  const FINGERPRINT = Buffer.from('ISO19794-2 sample template').toString('base64');

  before(async () => {
    cloud = await startMockCloud({ durationMinutes: 1 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'center-att-'));
    center = new Center(loadConfig({ dataDir: dir, cloudUrl: cloud.url, tls: false, lateSyncWindowSeconds: 0, requireAttendance: true }));
    app = createApp(center);
    center.setupAdmin('Admin@12345', true);
    A = { Authorization: `Bearer ${center.adminLogin('Admin@12345', '127.0.0.1').token}` };
    await center.activate(cloud.centerCode, cloud.activationKey, 'test');
    await center.paper.sync('test');
    await center.paper.unlock(cloud.examId, 'test', cloud.releaseCode);
    for (const id of ['PC-LAB-0001', 'PC-LAB-0002']) {
      const tok = (await request(app).post('/client/register').send({ machineId: id, hostname: id.toLowerCase() })).body.data.machineToken;
      pcs[id] = { 'X-Machine-Id': id, 'X-Machine-Token': tok };
    }
  });
  after(async () => { center.stop(); await cloud.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('refuses login before attendance when attendance is required', async () => {
    const r = await login('PC-LAB-0001', 'R001', 'PASS-0001');
    assert.equal(r.status, 403);
    assert.match(r.body.message, /attendance desk/);
    const l = (await request(app).get(`${base()}/attendance`).set(A)).body.data;
    assert.equal(l.summary.total, 2);
    assert.equal(l.candidates[0].attendance, 'pending');
    assert.equal(l.freeMachines.length, 2);
  });

  it('validates verification evidence', async () => {
    assert.equal((await request(app).post(`${base()}/attendance/R001`).set(A).send({ method: 'photo' })).status, 400, 'photo match must be confirmed');
    assert.equal((await request(app).post(`${base()}/attendance/R001`).set(A).send({ method: 'manual_override' })).status, 400, 'override needs a reason');
    assert.equal((await request(app).post(`${base()}/attendance/R001`).set(A).send({ method: 'fingerprint' })).status, 400, 'fingerprint method needs a template');
    assert.equal((await request(app).post(`${base()}/attendance/R999`).set(A).send({ method: 'photo', photoMatched: true })).status, 404);
    assert.equal((await request(app).post(`${base()}/attendance/R001`).send({ method: 'photo', photoMatched: true })).status, 401, 'admin auth required');
  });

  it('marks present with a sealed fingerprint and allocates a PC', async () => {
    const r = await request(app).post(`${base()}/attendance/R001`).set(A).send({ method: 'photo_fingerprint', photoMatched: true, fingerprintTemplate: FINGERPRINT, fingerprintFormat: 'ISO19794-2', livePhoto: 'aGVsbG8=' });
    assert.equal(r.status, 200, r.body.message);
    assert.equal(r.body.data.attendance, 'present');
    assert.equal(r.body.data.fingerprintCaptured, true);
    const row = center.db.get<{ fingerprint_sealed: string }>('SELECT fingerprint_sealed FROM attendance WHERE roll_number = ?', 'R001')!;
    assert.ok(!row.fingerprint_sealed.includes(FINGERPRINT), 'template is sealed at rest');
    assert.equal(center.sealer.open(row.fingerprint_sealed), FINGERPRINT);

    assert.equal((await request(app).post(`${base()}/allocate/R002`).set(A).send({ machineId: 'PC-LAB-0002' })).status, 409, 'cannot allocate before present');
    const al = await request(app).post(`${base()}/allocate/R001`).set(A).send({ machineId: 'PC-LAB-0002' });
    assert.equal(al.status, 200, al.body.message);
    assert.equal(al.body.data.machineId, 'PC-LAB-0002');
  });

  it('shows the allocated candidate on that PC only', async () => {
    const a2 = (await request(app).get('/client/assignment').set(pcs['PC-LAB-0002'])).body.data;
    assert.equal(a2.assigned, true);
    assert.equal(a2.candidate.rollNumber, 'R001');
    assert.ok(a2.candidate.name);
    assert.equal((await request(app).get('/client/assignment').set(pcs['PC-LAB-0001'])).body.data.assigned, false);
    assert.equal((await request(app).get('/client/assignment')).status, 401, 'machine auth required');
  });

  it('only the allocated candidate can log in on the allocated PC', async () => {
    assert.equal((await login('PC-LAB-0001', 'R001', 'PASS-0001')).status, 403, 'R001 on the wrong PC');
    await request(app).post(`${base()}/attendance/R002`).set(A).send({ method: 'manual_override', overrideReason: 'Scanner failed; ID card checked' });
    const other = await login('PC-LAB-0002', 'R002', 'PASS-0002');
    assert.equal(other.status, 403);
    assert.match(other.body.message, /allocated to R001/);
    assert.equal((await request(app).post(`${base()}/allocate/R002`).set(A).send({ machineId: 'PC-LAB-0002' })).status, 409, 'PC already taken');
    const ok = await login('PC-LAB-0002', 'R001', 'PASS-0001');
    assert.equal(ok.status, 200, ok.body.message);
    assert.equal((await request(app).delete(`${base()}/allocate/R001`).set(A)).status, 409, 'cannot release after login');
  });

  it('absent candidates cannot log in and cannot be allocated', async () => {
    assert.equal((await request(app).post(`${base()}/attendance/R002`).set(A).send({ status: 'absent' })).status, 200);
    assert.equal((await request(app).post(`${base()}/allocate/R002`).set(A).send({})).status, 409);
    assert.equal((await login('PC-LAB-0001', 'R002', 'PASS-0002')).status, 403);
    assert.equal((await request(app).post(`${base()}/attendance/R001`).set(A).send({ status: 'absent' })).status, 409, 'R001 already logged in');
  });

  it('uploads attendance evidence with results but never raw biometrics', async () => {
    center.engine.startExam(cloud.examId, 'test');
    center.engine.end(cloud.examId, 'test');
    await center.sync.run({ force: true });
    assert.equal(center.sync.status()[0].status, 'synced');
    const payloads = center.db.all<{ payload: string }>('SELECT payload FROM sync_batches').map((b) => b.payload);
    assert.ok(cloud.uploads.length > 0);
    const att = payloads.flatMap((p) => JSON.parse(p).attempts).find((x: { rollNumber: string }) => x.rollNumber === 'R001').attendance;
    assert.equal(att.status, 'present');
    assert.equal(att.method, 'photo_fingerprint');
    assert.equal(att.fingerprintCaptured, true);
    assert.equal(att.allocatedMachineId, 'PC-LAB-0002');
    assert.ok(!payloads.some((p) => p.includes(FINGERPRINT)), 'no raw template in the result package');
    const audit = center.audit.list(500).map((e: { action: string }) => e.action);
    for (const a of ['attendance.present', 'attendance.allocated', 'attendance.absent', 'auth.login_refused']) assert.ok(audit.includes(a), a);
    assert.equal(center.audit.verify().ok, true);
  });
});
