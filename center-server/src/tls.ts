import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import selfsigned from 'selfsigned';

/** Self-signed LAN certificate; clients pin its SHA-256 fingerprint (shown on the admin dashboard / discovery). */
export const loadOrCreateCert = (dir: string, lanIp: string, hostname: string) => {
  const keyFile = path.join(dir, 'tls-key.pem');
  const certFile = path.join(dir, 'tls-cert.pem');
  const ipFile = path.join(dir, 'tls-ip.txt');
  const stale = !fs.existsSync(certFile) || (fs.existsSync(ipFile) && fs.readFileSync(ipFile, 'utf8') !== lanIp);
  if (stale) {
    const pems = selfsigned.generate([{ name: 'commonName', value: `TheSpot Center ${hostname}` }], {
      keySize: 2048, days: 3650, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: lanIp }, { type: 7, ip: '127.0.0.1' }, { type: 2, value: hostname }, { type: 2, value: 'localhost' }] }],
    });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(ipFile, lanIp);
  }
  const cert = fs.readFileSync(certFile, 'utf8');
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  return { key: fs.readFileSync(keyFile, 'utf8'), cert, fingerprint };
};
