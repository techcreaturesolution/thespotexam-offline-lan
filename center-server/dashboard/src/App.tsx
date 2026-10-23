import { useCallback, useEffect, useRef, useState } from 'react';
import AttendanceDesk from './Attendance';
import { api, ApiError, ExamInfo, Live, LiveRow, Status, SyncExam, token, Violation } from './api';

const fmt = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '—');

const STATUS_STYLE: Record<string, string> = {
  not_started: 'bg-gray-100 text-gray-700',
  in_progress: 'bg-blue-100 text-blue-800',
  disconnected: 'bg-amber-100 text-amber-800',
  submitted: 'bg-green-100 text-green-800',
  auto_submitted: 'bg-green-100 text-green-800',
  force_submitted: 'bg-green-100 text-green-800',
  disqualified: 'bg-red-100 text-red-800',
  absent: 'bg-gray-200 text-gray-600',
};
const label = (s: string) => s.replace(/_/g, ' ');
const Badge = ({ s }: { s: string }) => <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[s] || 'bg-gray-100 text-gray-700'}`}>{label(s)}</span>;

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      if (setup) await api('POST', '/admin/setup', { password });
      const r = await api<{ token: string }>('POST', '/admin/login', { password });
      token.set(r.token); onLogin();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !setup) { setSetup(true); setError('No admin password is set yet. Choose one (only possible from the server PC itself).'); }
      else setError((err as Error).message);
    }
  };
  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={submit} className="card w-80 space-y-3">
        <h1 className="text-lg font-semibold">Center Server admin</h1>
        <input className="input" type="password" autoFocus placeholder={setup ? 'New admin password (min 8)' : 'Admin password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full">{setup ? 'Set password and sign in' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Activate({ onDone }: { onDone: () => void }) {
  const [centerCode, setCode] = useState('');
  const [activationKey, setKey] = useState('');
  const a = useAction(onDone);
  return (
    <div className="card space-y-3 max-w-md">
      <h2 className="font-semibold">Activate this center</h2>
      <p className="text-sm text-gray-600">Needs internet. Use the Center ID and activation key from the cloud admin (Offline Exam → LAN Center Servers).</p>
      <input className="input" placeholder="Center ID" value={centerCode} onChange={(e) => setCode(e.target.value)} />
      <input className="input" placeholder="Activation key" value={activationKey} onChange={(e) => setKey(e.target.value)} />
      {a.error && <p className="text-sm text-red-600">{a.error}</p>}
      <button className="btn-primary" disabled={a.busy || !centerCode || !activationKey} onClick={() => a.run(() => api('POST', '/admin/activate', { centerCode, activationKey }))}>Activate</button>
    </div>
  );
}

function ExamControls({ exam, live, onChange }: { exam: ExamInfo; live: Live | null; onChange: () => void }) {
  const a = useAction(onChange);
  const [releaseCode, setReleaseCode] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [roll, setRoll] = useState('');
  const base = `/admin/exams/${exam.examId}`;
  const confirmRun = (msg: string, fn: () => Promise<unknown>) => { if (window.confirm(msg)) a.run(fn); };
  const s = exam.state;
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">{exam.title}</h2>
        <Badge s={s} />
        {live && ['running', 'paused'].includes(s) && <span className="font-mono text-lg">{fmt(live.exam.remainingSeconds)}</span>}
        {exam.message && <span className="text-sm text-gray-500">{exam.message}</span>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {s === 'locked' && exam.keyReleaseMode !== 'time' && (
          <>
            <input className="input w-48" placeholder="Release code" value={releaseCode} onChange={(e) => setReleaseCode(e.target.value)} />
            <button className="btn-primary" disabled={a.busy || !releaseCode} onClick={() => a.run(() => api('POST', `${base}/unlock`, { releaseCode }))}>Unlock paper</button>
          </>
        )}
        {s === 'locked' && exam.keyReleaseMode === 'time' && (
          <button className="btn-primary" disabled={a.busy} onClick={() => a.run(() => api('POST', `${base}/unlock`, {}))}>Unlock paper (release time {time(exam.keyReleaseAt)})</button>
        )}
        {s === 'unlocked' && <button className="btn-primary" disabled={a.busy} onClick={() => confirmRun('Start the exam for all candidates now?', () => api('POST', `${base}/start`))}>Start exam</button>}
        {s === 'running' && <button className="btn" disabled={a.busy} onClick={() => a.run(() => api('POST', `${base}/pause`, { reason: window.prompt('Reason for pausing?') || undefined }))}>Pause</button>}
        {s === 'paused' && <button className="btn-primary" disabled={a.busy} onClick={() => a.run(() => api('POST', `${base}/resume`))}>Resume</button>}
        {['running', 'paused'].includes(s) && (
          <>
            <input className="input w-20" type="number" min={1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            <input className="input w-36" placeholder="Roll no. (blank = all)" value={roll} onChange={(e) => setRoll(e.target.value)} />
            <button className="btn" disabled={a.busy || minutes < 1} onClick={() => a.run(() => api('POST', `${base}/extend`, { minutes, rollNumber: roll || undefined, reason: window.prompt('Reason for extra time?') || undefined }))}>Add minutes</button>
            <button className="btn-danger" disabled={a.busy} onClick={() => confirmRun('End the exam? Every open attempt is force-submitted.', () => api('POST', `${base}/end`))}>End exam</button>
          </>
        )}
      </div>
      {a.error && <p className="text-sm text-red-600">{a.error}</p>}
    </div>
  );
}

function PcGrid({ exam, live, onChange }: { exam: ExamInfo; live: Live; onChange: () => void }) {
  const a = useAction(onChange);
  const [filter, setFilter] = useState('all');
  const rows = live.candidates.filter((r) => filter === 'all' || r.status === filter || (filter === 'submitted' && r.status.endsWith('submitted')));
  const reset = (r: LiveRow) => {
    const reopen = r.status.endsWith('submitted') && window.confirm(`Re-open ${r.rollNumber}'s submitted attempt? Cancel = only release the PC binding.`);
    const reason = window.prompt(`Reason for resetting ${r.rollNumber}?`);
    if (reason === null) return;
    a.run(() => api('POST', `/admin/exams/${exam.examId}/reset-candidate`, { rollNumber: r.rollNumber, reopen, reason }));
  };
  const S = live.summary;
  const tiles: [string, string, number][] = [['all', 'Total', S.total], ['not_started', 'Not started', S.notStarted], ['in_progress', 'In progress', S.inProgress], ['disconnected', 'Disconnected', S.disconnected], ['submitted', 'Submitted', S.submitted], ['absent', 'Absent', S.absent]];
  return (
    <div className="card space-y-3">
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {tiles.map(([k, l, n]) => (
          <button key={k} onClick={() => setFilter(k)} className={`rounded-md border p-2 text-left ${filter === k ? 'border-primary-500 bg-primary-50' : 'border-gray-200'}`}>
            <div className="text-xs text-gray-500">{l}</div><div className="text-xl font-semibold">{n ?? 0}</div>
          </button>
        ))}
      </div>
      {a.error && <p className="text-sm text-red-600">{a.error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-500 border-b"><tr><th className="py-1">Seat</th><th>Roll no.</th><th>Name</th><th>Status</th><th>PC</th><th>Answered</th><th>Time left</th><th>Violations</th><th>Last seen</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.candidateId} className="border-b last:border-0">
                <td className="py-1">{r.seatNumber ?? '—'}</td><td className="font-mono">{r.rollNumber}</td><td>{r.name}</td><td><Badge s={r.status} /></td>
                <td>{r.hostname ? `${r.hostname} (${r.ip})` : '—'}</td><td>{r.answered}/{r.totalQuestions}</td>
                <td className="font-mono">{r.status === 'in_progress' || r.status === 'disconnected' ? fmt(r.remainingSeconds) : '—'}</td>
                <td className={r.violations ? 'text-red-600 font-medium' : ''}>{r.violations}</td><td>{time(r.lastSeenAt)}</td>
                <td>{r.status !== 'not_started' && <button className="btn text-xs" disabled={a.busy} onClick={() => reset(r)}>Reset</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="py-4 text-center text-gray-500">No candidates</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ViolationFeed({ examId }: { examId: string }) {
  const [items, setItems] = useState<Violation[]>([]);
  const since = useRef(0);
  useEffect(() => {
    since.current = 0; setItems([]);
    let stop = false;
    const tick = async () => {
      try {
        const v = await api<Violation[]>('GET', `/admin/violations?examId=${examId}&sinceId=${since.current}`);
        if (stop || !v.length) return;
        since.current = Math.max(since.current, ...v.map((x) => x.id));
        setItems((old) => [...v.sort((x, y) => y.id - x.id), ...old].slice(0, 300));
      } catch { /* shown by the main poll */ }
    };
    tick(); const t = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [examId]);
  return (
    <div className="card">
      <h3 className="font-semibold mb-2">Violations</h3>
      <ul className="text-sm max-h-96 overflow-y-auto divide-y">
        {items.map((v) => (<li key={v.id} className="py-1"><span className="text-gray-500 mr-2">{time(v.at)}</span><span className="font-mono mr-2">{v.roll_number || v.candidate_id}</span><span className="font-medium text-red-700">{label(v.type)}</span>{v.detail && <span className="text-gray-600"> — {v.detail}</span>}</li>))}
        {!items.length && <li className="py-2 text-gray-500">None yet</li>}
      </ul>
    </div>
  );
}

function SyncPanel({ onChange }: { onChange: () => void }) {
  const [data, setData] = useState<{ pendingBatches: number; exams: SyncExam[] } | null>(null);
  const load = useCallback(() => api<{ pendingBatches: number; exams: SyncExam[] }>('GET', '/admin/sync').then(setData).catch(() => undefined), []);
  const a = useAction(() => { load(); onChange(); });
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  return (
    <div className="card space-y-2">
      <div className="flex items-center gap-3">
        <h3 className="font-semibold">Result sync to cloud</h3>
        <span className="text-sm text-gray-500">{data ? `${data.pendingBatches} batch(es) pending` : '…'}</span>
        <button className="btn ml-auto" disabled={a.busy} onClick={() => a.run(() => api('POST', '/admin/sync/run'))}>Sync now</button>
      </div>
      {a.error && <p className="text-sm text-red-600">{a.error}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500 border-b"><tr><th className="py-1">Exam</th><th>Status</th><th>Attempts synced</th><th>Cloud accepted / dup / rejected</th><th>Note</th></tr></thead>
        <tbody>
          {data?.exams.map((e) => (
            <tr key={e.examId} className="border-b last:border-0"><td className="py-1 font-mono text-xs">{e.examId}</td><td><Badge s={e.status} /></td><td>{e.attempts.synced} / {e.attempts.synced + e.attempts.pending + e.attempts.rejected}</td><td>{e.cloud.accepted} / {e.cloud.duplicates} / {e.cloud.rejected}</td><td className="text-gray-600">{e.message || e.batches.find((b) => b.lastError)?.lastError || ''}</td></tr>
          ))}
          {!data?.exams.length && <tr><td colSpan={5} className="py-2 text-gray-500">Nothing to sync yet. Results are packaged after an exam ends.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!token.get());
  const [status, setStatus] = useState<Status | null>(null);
  const [examId, setExamId] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'control' | 'attendance'>('control');
  const papers = useAction(() => refresh());

  const refresh = useCallback(async () => {
    try {
      const s = await api<Status>('GET', '/admin/status');
      setStatus(s); setError(null);
      const id = examId && s.exams.some((e) => e.examId === examId) ? examId : s.exams[0]?.examId ?? null;
      setExamId(id);
      setLive(id ? await api<Live>('GET', `/admin/exams/${id}/live`).catch(() => null) : null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
      else setError((e as Error).message);
    }
  }, [examId]);

  useEffect(() => { if (!authed) return; refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [authed, refresh]);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  const exam = status?.exams.find((e) => e.examId === examId);
  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{status?.centerName || 'Center Server'}</h1>
        {status?.centerCode && <span className="font-mono text-sm text-gray-500">{status.centerCode}</span>}
        {status && <span className="text-sm text-gray-500">LAN {status.tls ? 'https' : 'http'}://{status.lanIp}:{status.port} · {status.connectedClients} PC(s) online · v{status.appVersion}</span>}
        <button className="btn ml-auto" onClick={() => { token.clear(); setAuthed(false); }}>Sign out</button>
      </header>
      {error && <div className="rounded-md bg-red-50 border border-red-200 text-red-700 text-sm p-2">{error}</div>}
      {status && !status.activated && <Activate onDone={refresh} />}
      {status?.activated && (
        <div className="flex flex-wrap items-center gap-2">
          {status.exams.map((e) => (<button key={e.examId} className={examId === e.examId ? 'btn-primary' : 'btn'} onClick={() => setExamId(e.examId)}>{e.title}</button>))}
          <button className="btn ml-auto" disabled={papers.busy} onClick={() => papers.run(() => api('POST', '/admin/sync-papers'))}>{papers.busy ? 'Downloading…' : 'Download papers (online)'}</button>
          {papers.error && <span className="text-sm text-red-600">{papers.error}</span>}
        </div>
      )}
      {status?.activated && !status.exams.length && <p className="text-sm text-gray-500">No exams yet. Click “Download papers” while online.</p>}
      {exam && (
        <div className="flex gap-2 border-b">
          {(['control', 'attendance'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === t ? 'border-primary-600 text-primary-700 font-medium' : 'border-transparent text-gray-600'}`}>{t === 'control' ? 'Exam control' : 'Attendance desk'}</button>)}
        </div>
      )}
      {exam && tab === 'attendance' && <AttendanceDesk examId={exam.examId} examState={exam.state} />}
      {exam && tab === 'control' && <ExamControls exam={exam} live={live} onChange={refresh} />}
      {exam && live && tab === 'control' && (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2"><PcGrid exam={exam} live={live} onChange={refresh} /></div>
          <ViolationFeed examId={exam.examId} />
        </div>
      )}
      {status?.activated && <SyncPanel onChange={refresh} />}
      {status?.certFingerprint && <p className="text-xs text-gray-400 font-mono">Certificate SHA-256: {status.certFingerprint}</p>}
    </div>
  );
}
