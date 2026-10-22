import crypto from 'crypto';
import express from 'express';
import http from 'http';
import zlib from 'zlib';
import { AddressInfo } from 'net';
import { aesGcmEncrypt, generateKeyPair, normalizeCode, PACKAGE_MAGIC, sha256Hex } from '../src/crypto';

const scryptHash = (s: string) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$16384$8$1$${salt.toString('base64')}$${crypto.scryptSync(s, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
};

/** Minimal stand-in for the cloud Center APIs using the same TSPKG1 format and key-wrap as the real backend. */
export const startMockCloud = async (opts: { durationMinutes?: number; mode?: 'otp' | 'online' } = {}) => {
  const signing = generateKeyPair();
  const centerCode = 'CTR-TEST01';
  const activationKey = 'AAAA-BBBB-CCCC-DDDD';
  const examId = '665f00000000000000000001';
  const releaseCode = 'REL1-REL2-REL3';
  const accessCodes: Record<string, string> = { R001: 'PASS-0001', R002: 'PASS-0002' };
  const questions = [1, 2, 3].map((n) => ({ id: `q${n}`, sectionIndex: 0, type: 'mcq_single', text: `Question ${n}?`, html: null, options: [0, 1, 2, 3].map((i) => ({ id: i, text: `Opt ${i}` })), marks: 1, negativeMarks: 0, attachments: [] }));
  const packageId = `pkg_${crypto.randomUUID()}`;
  const payload = {
    packageId, center: { code: centerCode, name: 'Test Center' },
    exam: { id: examId, title: 'Mock Exam', instructions: 'Answer all', totalDurationMinutes: opts.durationMinutes ?? 1, totalMarks: 3,
      settings: { randomizeSections: false, randomizeOptions: true, allowReview: true, autoSubmitOnTimeout: true, lateEntryMinutes: 0 },
      sections: [{ index: 0, name: 'A', description: '', durationMinutes: 1, sectionTimerMinutes: null, marksPerQuestion: 1, negativeMarks: 0, randomizeQuestions: true, questionIds: questions.map((q) => q.id) }] },
    questions,
    candidates: Object.entries(accessCodes).map(([roll, code], i) => ({ id: `66600000000000000000000${i + 1}`, rollNumber: roll, name: `Cand ${roll}`, gender: null, seatNumber: i + 1, labId: null, passwordHash: scryptHash(normalizeCode(code)), dobHash: null, photo: null })),
    seats: [], seatMapEnforced: false,
  };
  const paperKey = crypto.randomBytes(32);
  const { iv, tag, ciphertext } = aesGcmEncrypt(paperKey, zlib.gzipSync(Buffer.from(JSON.stringify(payload))), Buffer.from(packageId));
  const header = Buffer.from(JSON.stringify({ format: 'TSPKG', version: 1, packageId, examId, centerCode, createdAt: new Date().toISOString(), cipher: 'aes-256-gcm', aad: 'packageId', encoding: 'gzip+json', iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertextLength: ciphertext.length, ciphertextSha256: sha256Hex(ciphertext), summary: { questions: 3, candidates: 2 } }));
  const sig = Buffer.from(crypto.sign(null, header, signing.privateKey).toString('base64'));
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const file = Buffer.concat([PACKAGE_MAGIC, u32(header.length), header, u32(sig.length), sig, ciphertext]);
  const salt = crypto.randomBytes(16);
  const kek = crypto.scryptSync(normalizeCode(releaseCode), salt, 32, { N: 16384, r: 8, p: 1 });
  const w = aesGcmEncrypt(kek, paperKey);
  const wrappedKey = { alg: 'scrypt+aes-256-gcm', salt: salt.toString('base64'), N: 16384, r: 8, p: 1, iv: w.iv.toString('base64'), tag: w.tag.toString('base64'), wrappedKey: w.ciphertext.toString('base64') };
  const apiToken = 'tok_' + crypto.randomUUID();
  const statusReports: unknown[] = [];
  const state = { keyLocked: false, served: file };

  const app = express();
  app.use(express.json());
  const auth: express.RequestHandler = (req, res, next) => (req.header('X-Center-Id') === centerCode && req.header('Authorization') === `Bearer ${apiToken}` ? next() : res.status(401).json({ success: false, message: 'Invalid center credentials' }));
  app.post('/center/activate', (req, res) => req.body.activationKey === activationKey ? res.json({ success: true, data: { centerCode, apiToken, cloudPublicKey: signing.publicKey, center: { name: 'Test Center' } } }) : res.status(401).json({ success: false, message: 'Invalid Center ID or activation key' }));
  app.get('/center/exams', auth, (_req, res) => res.json({ success: true, data: [{ examId, title: 'Mock Exam', scheduledStart: new Date().toISOString(), scheduledEnd: new Date().toISOString(), totalDurationMinutes: payload.exam.totalDurationMinutes, packageId, keyReleaseMode: opts.mode || 'otp', keyReleaseAt: new Date().toISOString(), paperStatus: 'not_downloaded', syncStatus: 'not_started' }] }));
  app.get('/paper/manifest/:id', auth, (_req, res) => res.json({ success: true, data: { examId, packageId, size: file.length, sha256: sha256Hex(file), keyReleaseMode: opts.mode || 'otp', keyReleaseAt: new Date().toISOString(), wrappedKey: opts.mode === 'online' ? undefined : wrappedKey, cloudPublicKey: signing.publicKey } }));
  app.get('/paper/download/:id', auth, (req, res) => {
    const m = /bytes=(\d+)-/.exec(req.header('Range') || '');
    if (m) { const s = +m[1]; res.status(206).set('Content-Range', `bytes ${s}-${file.length - 1}/${file.length}`).end(state.served.subarray(s)); return; }
    res.end(state.served);
  });
  app.post('/paper/key/:id', auth, (_req, res) => state.keyLocked ? res.status(403).json({ success: false, message: 'Key is time-locked' }) : res.json({ success: true, data: { packageId, paperKey: paperKey.toString('base64') } }));
  app.post('/center/status', auth, (req, res) => { statusReports.push(req.body); res.json({ success: true, data: { serverTime: new Date().toISOString() } }); });

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, server, centerCode, activationKey, examId, releaseCode, accessCodes, packageId, file, statusReports, state, close: () => new Promise((r) => server.close(r)) };
};
