import crypto from 'crypto';
import fs from 'fs';
import zlib from 'zlib';
import type { PaperPayload } from './types';

export const sha256Hex = (d: crypto.BinaryLike) => crypto.createHash('sha256').update(d).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const normalizeCode = (c: string) => c.replace(/[\s-]/g, '').toUpperCase();
export const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export const aesGcmEncrypt = (key: Buffer, pt: Buffer, aad?: Buffer) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(pt), c.final()]);
  return { iv, tag: c.getAuthTag(), ciphertext };
};
export const aesGcmDecrypt = (key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad?: Buffer) => {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
};

/** Local at-rest sealing with the machine master key (secrets in SQLite, MACs over result rows). */
export class Sealer {
  constructor(private readonly key: Buffer) {}
  static fromFile(file: string): Sealer {
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    return new Sealer(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'));
  }
  seal(pt: string): string {
    const { iv, tag, ciphertext } = aesGcmEncrypt(this.key, Buffer.from(pt, 'utf8'));
    return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
  }
  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1') throw new Error('Unknown sealed format');
    return aesGcmDecrypt(this.key, Buffer.from(iv, 'base64'), Buffer.from(tag, 'base64'), Buffer.from(ct, 'base64')).toString('utf8');
  }
  mac(...parts: unknown[]): string {
    return crypto.createHmac('sha256', this.key).update(JSON.stringify(parts)).digest('base64url');
  }
}

/** Verifies hashes produced by the cloud: scrypt$N$r$p$saltB64$hashB64 */
export const verifyScrypt = (secret: string, stored: string): boolean => {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(secret, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(expected, got);
};

export interface WrappedKey { alg: string; salt: string; N: number; r: number; p: number; iv: string; tag: string; wrappedKey: string }

/** OTP release: derive KEK from the release code and unwrap the paper key (wrong code fails the GCM tag). */
export const unwrapKeyWithCode = (w: WrappedKey, releaseCode: string): Buffer => {
  if (w.alg !== 'scrypt+aes-256-gcm') throw new Error(`Unsupported key wrap ${w.alg}`);
  const kek = crypto.scryptSync(normalizeCode(releaseCode), Buffer.from(w.salt, 'base64'), 32, { N: w.N, r: w.r, p: w.p, maxmem: 64 * 1024 * 1024 });
  return aesGcmDecrypt(kek, Buffer.from(w.iv, 'base64'), Buffer.from(w.tag, 'base64'), Buffer.from(w.wrappedKey, 'base64'));
};

export const generateKeyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};
export const ed25519Sign = (privPem: string, data: Buffer | string) =>
  crypto.sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), privPem).toString('base64');
export const ed25519Verify = (pubPem: string, data: Buffer | string, sigB64: string) => {
  try {
    return crypto.verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), pubPem, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
};

export const PACKAGE_MAGIC = Buffer.from('TSPKG1\n', 'utf8');

export interface PackageHeader {
  format: string; version: number; packageId: string; examId: string; centerCode: string; createdAt: string;
  cipher: string; aad: string; encoding: string; iv: string; tag: string; ciphertextLength: number; ciphertextSha256: string;
  summary?: Record<string, number>;
}

export const parsePackage = (file: Buffer) => {
  if (file.length < PACKAGE_MAGIC.length + 8 || !file.subarray(0, PACKAGE_MAGIC.length).equals(PACKAGE_MAGIC)) {
    throw new Error('Not a TSPKG1 package');
  }
  let o = PACKAGE_MAGIC.length;
  const hLen = file.readUInt32BE(o); o += 4;
  const headerBytes = file.subarray(o, o + hLen); o += hLen;
  const sLen = file.readUInt32BE(o); o += 4;
  const signature = file.subarray(o, o + sLen).toString('utf8'); o += sLen;
  const ciphertext = file.subarray(o);
  return { headerBytes, header: JSON.parse(headerBytes.toString('utf8')) as PackageHeader, signature, ciphertext };
};

/** Signature over the exact header bytes, then ciphertext length+hash, then identity binding. */
export const verifyPackage = (file: Buffer, cloudPublicKey: string, expect: { examId: string; centerCode: string; packageId?: string }) => {
  const p = parsePackage(file);
  if (!ed25519Verify(cloudPublicKey, p.headerBytes, p.signature)) throw new Error('Package signature invalid');
  const h = p.header;
  if (h.format !== 'TSPKG' || h.version !== 1 || h.cipher !== 'aes-256-gcm' || h.encoding !== 'gzip+json') throw new Error('Unsupported package format');
  if (p.ciphertext.length !== h.ciphertextLength || sha256Hex(p.ciphertext) !== h.ciphertextSha256) throw new Error('Package ciphertext tampered');
  if (h.examId !== expect.examId || h.centerCode !== expect.centerCode) throw new Error('Package is for a different exam or center');
  if (expect.packageId && h.packageId !== expect.packageId) throw new Error('Package ID mismatch');
  return p;
};

export const decryptPackage = (file: Buffer, paperKey: Buffer): PaperPayload => {
  const { header, ciphertext } = parsePackage(file);
  const pt = aesGcmDecrypt(paperKey, Buffer.from(header.iv, 'base64'), Buffer.from(header.tag, 'base64'), ciphertext, Buffer.from(header.packageId, 'utf8'));
  const payload = JSON.parse(zlib.gunzipSync(pt).toString('utf8')) as PaperPayload;
  if (payload.packageId !== header.packageId) throw new Error('Decrypted payload does not match header');
  return payload;
};
