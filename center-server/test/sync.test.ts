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
const DAY = 86400_000;

describe('Center Server phase 4: result sync', () => {
  let cloud: Mock;
  let dir: string;
  let center: Center;
  let app: ReturnType<typeof createApp>;
  let adminTok = '';
  const boot = () => {
    center = new Center(loadConfig({ dataDir: dir, cloudUrl: cloud.url, tls: false, lateSyncWindowSeconds: 0, syncBatchSize: 1, syncBackoffBaseSeconds: 60, retentionDays: 30 }));
    app = createApp(center);
  };
  const batches = () => center.db.all<{ batch_id: string; batch_index: number; status: string; tries: number; next_try_at: string | null; last_error: string | null; payload: string }>('SELECT * FROM sync_batches ORDER BY batch_index');
  const examSync = () => center.sync.status()[0];

  before(async () => {
    cloud = await startMockCloud({ durationMinutes: 1 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'center-sync-'));
    boot();
    center.setupAdmin('Admin@12345', true);
    adminTok = center.adminLogin('Admin@12345', '127.0.0.1').token;
    await center.activate(cloud.centerCode, cloud.activationKey, 'test');
    await center.paper.sync('test');
    await center.paper.unlock(cloud.examId, 'test', cloud.releaseCode);
    center.engine.startExam(cloud.examId, 'test');
    const m = { 'X-Machine-Id': 'PC-LAB-0001' } as Record<string, string>;
    m['X-Machine-Token'] = (await request(app).post('/client/register').send({ machineId: 'PC-LAB-0001', hostname: 'pc1' })).body.data.machineToken;
    const s = (await request(app).post('/auth/login').set(m).send({ rollNumber: 'R001', password: 'PASS-0001' })).body.data.sessionToken;
    const C = { ...m, Authorization: `Bearer ${s}` };
    await request(app).get('/exam/questions').set(C);
    assert.equal((await request(app).post('/answers/save').set(C).send({ answers: [{ questionId: 'q1', answer: 2, version: 1 }, { questionId: 'q2', answer: 1, version: 1 }] })).status, 200);
    await request(app).post('/violations/log').set(C).send({ violations: [{ type: 'focus_lost', detail: 'alt-tab' }] });
    assert.equal((await request(app).post('/exam/submit').set(C).send({})).status, 200);
  });
  after(async () => { center.stop(); await cloud.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('builds nothing while the exam is still running', async () => {
    await center.sync.run({ force: true });
    assert.equal(batches().length, 0);
    assert.equal(cloud.uploads.length, 0);
  });

  it('blocks upload when a local answer row was edited, until it is restored', async () => {
    center.engine.end(cloud.examId, 'test');
    const orig = center.db.get<{ answer_json: string }>(`SELECT answer_json FROM answers WHERE question_id = 'q1'`)!.answer_json;
    center.db.run(`UPDATE answers SET answer_json = '3' WHERE question_id = 'q1'`);
    cloud.state.uploadFailures = 99;
    await center.sync.run({ force: true });
    assert.equal(examSync().status, 'blocked');
    assert.equal(batches().length, 0);
    center.db.run(`UPDATE answers SET answer_json = ? WHERE question_id = 'q1'`, orig);
    cloud.state.uploadFailures = 0;
  });

  it('cloud unavailable: batches are built, signed, kept pending with backoff', async () => {
    cloud.state.uploadFailures = 1;
    await center.sync.run();
    const b = batches();
    assert.equal(b.length, 2, 'one attempt per batch (R001 submitted, R002 absent)');
    assert.equal(b[0].status, 'pending');
    assert.equal(b[0].tries, 1);
    assert.match(b[0].last_error || '', /unavailable/i);
    assert.ok(Date.parse(b[0].next_try_at!) > Date.now() + 30_000, 'exponential backoff applied');
    const p0 = JSON.parse(b[0].payload);
    const p1 = JSON.parse(b[1].payload);
    assert.equal(p0.attempts[0].rollNumber, 'R001');
    assert.equal(p0.attempts[0].status, 'submitted');
    assert.equal(p0.attempts[0].answers.length, 2);
    assert.equal(p0.attempts[0].violations[0].type, 'focus_lost');
    assert.equal(p1.attempts[0].status, 'absent');
    assert.equal(p1.isFinal, true);
    assert.deepEqual(p1.summary, { expected: 2, attempts: 2, submitted: 1, absent: 1 });
    assert.equal(center.sync.pendingBatches(), 2);
    await center.sync.run();
    assert.equal(batches()[0].tries, 1, 'not retried before backoff expires');
    assert.equal(cloud.uploads.length, 0, 'later batches wait for the same backoff');
  });

  it('survives a restart with identical signed payloads', async () => {
    const before = batches().map((b) => b.payload);
    center.stop();
    boot();
    assert.deepEqual(batches().map((b) => b.payload), before);
  });

  it('refuses to upload a batch edited on disk', async () => {
    const b = batches()[0];
    center.db.run('UPDATE sync_batches SET payload = ? WHERE batch_id = ?', b.payload.replace('"submitted"', '"disqualified"'), b.batch_id);
    cloud.state.loseAck = true;
    await center.sync.run({ force: true });
    assert.equal(batches()[0].status, 'error');
    assert.match(batches()[0].last_error || '', /tamper/);
    assert.deepEqual(cloud.uploads.map((u) => u.batchId), [batches()[1].batch_id], 'only the untouched batch reached the cloud');
    assert.equal(batches()[1].status, 'pending', 'cloud stored batch 1 but its ack was lost');
    center.db.run('UPDATE sync_batches SET payload = ? WHERE batch_id = ?', b.payload, b.batch_id);
  });

  it('rejects a tampered cloud ack; replays recover lost and tampered acks without duplicates', async () => {
    cloud.state.tamperAck = true;
    await center.sync.retryNow();
    assert.equal(batches()[0].status, 'pending');
    assert.match(batches()[0].last_error || '', /Ack signature invalid/);
    assert.equal(batches()[1].status, 'acked', 'lost ack for batch 1 recovered by replay');
    cloud.state.tamperAck = false;
    await center.sync.run({ force: true });
    assert.equal(batches()[0].status, 'acked');
    assert.deepEqual(cloud.uploads.map((u) => u.replayed), [false, false, true, true]);
    assert.equal(cloud.attemptsByKey.size, 2, 'no duplicate attempts in the cloud');
    const s = examSync();
    assert.equal(s.status, 'synced');
    assert.deepEqual(s.attempts, { pending: 0, synced: 2, rejected: 0 });
    assert.equal(s.cloud.accepted, 2);
    assert.equal(center.sync.pendingBatches(), 0);
    const r = await request(app).get('/admin/sync').set({ Authorization: `Bearer ${adminTok}` });
    assert.equal(r.body.data.exams[0].status, 'synced');
  });

  it('purges candidate data only after the retention period', async () => {
    center.sync.purge(Date.now() + 29 * DAY);
    assert.ok(center.db.get('SELECT 1 FROM attempts'));
    const pkg = center.paper.exam(cloud.examId).package_path!;
    center.sync.purge(Date.now() + 31 * DAY);
    for (const t of ['attempts', 'answers', 'violations']) assert.equal(center.db.get(`SELECT 1 FROM ${t}`), undefined, t);
    assert.equal(fs.existsSync(pkg), false);
    assert.ok(examSync().purgedAt);
    assert.equal(center.audit.verify().ok, true);
  });
});
