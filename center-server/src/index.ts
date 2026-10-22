import http from 'http';
import https from 'https';
import os from 'os';
import { createApp } from './app';
import { Center } from './center';
import { loadConfig } from './config';
import { startDiscovery } from './discovery';
import { loadOrCreateCert } from './tls';

const cfg = loadConfig();
const center = new Center(cfg);
const app = createApp(center);

let server: http.Server;
if (cfg.tls) {
  const tls = loadOrCreateCert(cfg.dataDir, cfg.lanIp, os.hostname());
  center.certFingerprint = tls.fingerprint;
  server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, app);
} else {
  server = http.createServer(app);
}
server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`[center] listening on ${cfg.tls ? 'https' : 'http'}://${cfg.lanIp}:${cfg.port} (data: ${cfg.dataDir})`);
  if (center.certFingerprint) console.log(`[center] certificate SHA-256 ${center.certFingerprint}`);
});
const disco = startDiscovery(cfg.discoveryPort, () => ({ centerCode: center.centerCode() || null, lanIp: cfg.lanIp, port: cfg.port, tls: cfg.tls, certFingerprint: center.certFingerprint }));
center.startBackground();

const shutdown = () => {
  console.log('[center] shutting down');
  disco.close();
  server.close(() => { center.stop(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
