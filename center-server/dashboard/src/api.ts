const KEY = 'center_admin_token';
export const token = { get: () => sessionStorage.getItem(KEY), set: (t: string) => sessionStorage.setItem(KEY, t), clear: () => sessionStorage.removeItem(KEY) };

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const t = token.get();
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    if (res.status === 401 && t) token.clear();
    throw new ApiError(res.status, json.message || `Request failed (${res.status})`);
  }
  return json.data as T;
}

export interface ExamInfo { examId: string; title: string; state: string; message?: string | null; scheduledStart?: string; keyReleaseMode?: string; keyReleaseAt?: string; packageId?: string | null }
export interface Status { centerCode?: string | null; centerName?: string; activated: boolean; lanIp: string; port: number; tls: boolean; certFingerprint?: string; appVersion: string; connectedClients: number; serverTime: string; exams: ExamInfo[] }
export interface LiveRow { candidateId: string; rollNumber: string; name: string; seatNumber?: number | null; status: string; loggedIn: boolean; hostname: string | null; ip: string | null; lastSeenAt: string | null; answered: number; totalQuestions: number; violations: number; remainingSeconds: number; extraSeconds: number }
export interface Live { exam: { examId: string; title: string; state: string; startedAt: string | null; elapsedSeconds: number; remainingSeconds: number; extraSeconds: number }; summary: Record<string, number>; candidates: LiveRow[] }
export interface Violation { id: number; exam_id: string | null; candidate_id: string | null; roll_number: string | null; machine_id: string | null; type: string; detail: string | null; at: string }
export interface SyncExam { examId: string; status: string; message: string | null; syncedAt: string | null; purgedAt: string | null; attempts: { pending: number; synced: number; rejected: number }; cloud: { accepted: number; duplicates: number; rejected: number }; batches: { batchId: string; index: number; status: string; attempts: number; tries: number; nextTryAt: string | null; lastError: string | null }[] }
