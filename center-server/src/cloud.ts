import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { HttpError } from './types';

export interface CloudCreds { centerCode: string; apiToken: string }

/** Thin client for the thespotexam.com cloud Center APIs (see docs in the cloud repo: docs/offline-lan). */
export class CloudClient {
  constructor(private readonly baseUrl: string, private readonly creds: () => CloudCreds | null, private readonly timeoutMs = 30000) {}

  private headers(auth: boolean): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) {
      const c = this.creds();
      if (!c) throw new HttpError(409, 'Center is not activated');
      h['X-Center-Id'] = c.centerCode;
      h.Authorization = `Bearer ${c.apiToken}`;
    }
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(auth),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; message?: string };
    if (!res.ok || json.success === false) throw new HttpError(res.status, json.message || `Cloud ${method} ${path} failed (${res.status})`);
    return json.data as T;
  }

  activate(body: { centerCode: string; activationKey: string; hardwareFingerprint: string; publicKey: string; hostname: string; appVersion: string }) {
    return this.request<{ centerCode: string; apiToken: string; cloudPublicKey: string; center: { name?: string; code?: string } }>('POST', '/center/activate', body, false);
  }
  exams() { return this.request<CloudExam[]>('GET', '/center/exams'); }
  manifest(examId: string) { return this.request<CloudManifest>('GET', `/paper/manifest/${examId}`); }
  releaseKey(examId: string) { return this.request<{ packageId: string; paperKey: string }>('POST', `/paper/key/${examId}`, {}); }
  uploadResults(payload: string, signature: string) {
    return this.request<{ ack: string; signature: string; replayed?: boolean }>('POST', '/results/upload', { payload, signature });
  }
  status(body: Record<string, unknown>) { return this.request<{ serverTime: string }>('POST', '/center/status', body); }

  /** Downloads to `dest`, resuming from an existing partial file via HTTP Range. */
  async download(examId: string, dest: string, expectedSize?: number): Promise<void> {
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (expectedSize && have === expectedSize) return;
    const headers = this.headers(true);
    if (have > 0 && (!expectedSize || have < expectedSize)) headers.Range = `bytes=${have}-`;
    const res = await fetch(`${this.baseUrl}/paper/download/${examId}`, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (res.status === 416) { fs.rmSync(dest, { force: true }); return this.download(examId, dest, expectedSize); }
    if (!res.ok || !res.body) throw new HttpError(res.status, `Paper download failed (${res.status})`);
    const append = res.status === 206;
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest, { flags: append ? 'a' : 'w' }));
  }

  async online(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/center/exams`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}

export interface CloudExam {
  examId: string; title: string; scheduledStart: string; scheduledEnd: string; totalDurationMinutes: number;
  packageId?: string; packageSha256?: string; packageSize?: number; keyReleaseMode: 'otp' | 'online'; keyReleaseAt: string;
  expectedCandidates?: number; paperStatus: string; syncStatus: string;
}
export interface CloudManifest {
  examId: string; packageId: string; size: number; sha256: string; keyReleaseMode: 'otp' | 'online'; keyReleaseAt: string;
  wrappedKey?: import('./crypto').WrappedKey; cloudPublicKey: string;
}
