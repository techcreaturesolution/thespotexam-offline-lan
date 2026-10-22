/**
 * Dev/demo harness for Candidate Client work: starts the mock cloud and a real Center Server, then activates,
 * downloads, verifies and unlocks a demo exam. No real cloud needed.
 *   npm run demo                      # HTTPS on LAN_IP:8443, exam unlocked, invigilator starts it
 *   DEMO_AUTOSTART=1 npm run demo     # also start the exam timer
 * Env: CENTER_PORT, LAN_IP, CENTER_TLS=false, DEMO_MINUTES (default 60), CENTER_DATA_DIR (default: fresh temp dir).
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import { Center } from '../src/center';
import { loadConfig } from '../src/config';
import { startDiscovery } from '../src/discovery';
import { loadOrCreateCert } from '../src/tls';
import { startMockCloud } from '../test/mockCloud';

(async () => {
  const cloud = await startMockCloud({ durationMinutes: Number(process.env.DEMO_MINUTES || 60) });
  const dataDir = process.env.CENTER_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'center-demo-'));
  const cfg = loadConfig({ dataDir, cloudUrl: cloud.url });
  const center = new Center(cfg);
  const adminPassword = 'Admin@12345';
  center.setupAdmin(adminPassword, true);
  await center.activate(cloud.centerCode, cloud.activationKey, 'demo');
  await center.paper.sync('demo');
  await center.paper.unlock(cloud.examId, 'demo', cloud.releaseCode);
  if (process.env.DEMO_AUTOSTART) center.engine.startExam(cloud.examId, 'demo');

  const app = createApp(center);
  let server: http.Server;
  if (cfg.tls) {
    const tls = loadOrCreateCert(cfg.dataDir, cfg.lanIp, os.hostname());
    center.certFingerprint = tls.fingerprint;
    server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, app);
  } else server = http.createServer(app);
  server.listen(cfg.port, '0.0.0.0');
  const disco = startDiscovery(cfg.discoveryPort, () => ({ centerCode: center.centerCode() || null, lanIp: cfg.lanIp, port: cfg.port, tls: cfg.tls, certFingerprint: center.certFingerprint }));
  center.startBackground();

  console.log(`\nCenter Server demo on ${cfg.tls ? 'https' : 'http'}://${cfg.lanIp}:${cfg.port}  (UDP discovery :${cfg.discoveryPort}, data ${dataDir})`);
  if (center.certFingerprint) console.log(`Certificate SHA-256: ${center.certFingerprint}`);
  console.log(`Exam ${cloud.examId} unlocked${process.env.DEMO_AUTOSTART ? ' and started' : ''}. Admin password: ${adminPassword}`);
  console.log('Candidates (roll / password):', Object.entries(cloud.accessCodes).map(([r, p]) => `${r} / ${p}`).join(', '));
  console.log(`Start: POST /admin/login {"password":"${adminPassword}"} then POST /admin/exams/${cloud.examId}/start with Bearer token\n`);

  const shutdown = () => { disco.close(); server.close(); center.stop(); cloud.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => { console.error(e); process.exit(1); });
