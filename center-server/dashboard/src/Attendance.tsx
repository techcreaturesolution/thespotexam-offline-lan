import { useCallback, useEffect, useRef, useState } from 'react';
import { api, photoSrc, Roster, RosterRow } from './api';

function Webcam({ onCapture }: { onCapture: (base64: string | null) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  const start = async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 } });
      setStream(s); setShot(null); onCapture(null);
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
    } catch (e) { setError(`Camera unavailable: ${(e as Error).message}`); }
  };
  const capture = () => {
    const v = video.current; if (!v) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const url = c.toDataURL('image/jpeg', 0.8);
    setShot(url); onCapture(url.split(',')[1]);
    stream?.getTracks().forEach((t) => t.stop()); setStream(null);
  };
  return (
    <div className="space-y-2">
      <div className="w-48 h-36 bg-gray-100 rounded border flex items-center justify-center overflow-hidden">
        {shot ? <img src={shot} alt="Live" className="object-cover w-full h-full" /> : <video ref={video} muted playsInline className={stream ? 'object-cover w-full h-full' : 'hidden'} />}
        {!shot && !stream && <span className="text-xs text-gray-500">No live photo</span>}
      </div>
      {stream ? <button className="btn" onClick={capture}>Capture</button> : <button className="btn" onClick={start}>{shot ? 'Retake' : 'Open camera'}</button>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Verify({ examId, row, roster, onDone }: { examId: string; row: RosterRow; roster: Roster; onDone: () => void }) {
  const [matched, setMatched] = useState(false);
  const [livePhoto, setLivePhoto] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [machineId, setMachineId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const path = `/admin/exams/${examId}`;
  const reg = photoSrc(row.photo);
  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2"><h3 className="font-semibold">{row.name}</h3><span className="font-mono text-sm text-gray-500">{row.rollNumber}</span>{row.seatNumber != null && <span className="text-sm text-gray-500">Seat {row.seatNumber}</span>}</div>
      <div className="flex flex-wrap gap-4">
        <div>
          <div className="text-xs text-gray-500 mb-1">Registered photo</div>
          <div className="w-48 h-36 bg-gray-100 rounded border flex items-center justify-center overflow-hidden">{reg ? <img src={reg} alt="Registered" className="object-cover w-full h-full" /> : <span className="text-xs text-gray-500">No photo in package</span>}</div>
        </div>
        <div><div className="text-xs text-gray-500 mb-1">Live photo</div><Webcam onCapture={setLivePhoto} /></div>
      </div>
      {row.attendance !== 'present' ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={matched} onChange={(e) => setMatched(e.target.checked)} /> The person at the desk matches the registered photo</label>
          <p className="text-xs text-gray-500">Fingerprint scanner: not configured on this desk.</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy || !matched} onClick={() => run(() => api('POST', `${path}/attendance/${row.rollNumber}`, { method: 'photo', photoMatched: true, livePhoto: livePhoto || undefined }))}>Mark present</button>
            <button className="btn" disabled={busy} onClick={() => run(() => api('POST', `${path}/attendance/${row.rollNumber}`, { status: 'absent' }))}>Mark absent</button>
          </div>
          <div className="flex gap-2">
            <input className="input" placeholder="Override reason (e.g. photo outdated, ID card checked)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn" disabled={busy || !reason.trim()} onClick={() => run(() => api('POST', `${path}/attendance/${row.rollNumber}`, { method: 'manual_override', photoMatched: matched, overrideReason: reason, livePhoto: livePhoto || undefined }))}>Override</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-green-700">Present ({row.method?.replace(/_/g, ' ')}) at {row.verifiedAt ? new Date(row.verifiedAt).toLocaleTimeString() : ''}{row.overrideReason ? ` — ${row.overrideReason}` : ''}</p>
          {row.machineId ? (
            <div className="flex items-center gap-2 text-sm"><span>Allocated PC: <b>{row.hostname || row.machineId}</b></span><button className="btn" disabled={busy} onClick={() => run(() => api('DELETE', `${path}/allocate/${row.rollNumber}`))}>Release</button></div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <select className="input w-56" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                <option value="">Choose a free PC…</option>
                {roster.freeMachines.map((m) => <option key={m.machineId} value={m.machineId}>{m.hostname || m.machineId}{m.online ? '' : ' (offline)'}</option>)}
              </select>
              <button className="btn-primary" disabled={busy || !machineId} onClick={() => run(() => api('POST', `${path}/allocate/${row.rollNumber}`, { machineId }))}>Allocate</button>
              <button className="btn" disabled={busy} onClick={() => run(() => api('POST', `${path}/allocate/${row.rollNumber}`, {}))}>Next free PC</button>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export default function AttendanceDesk({ examId, examState }: { examId: string; examState: string }) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const load = useCallback(() => api<Roster>('GET', `/admin/exams/${examId}/attendance`).then((r) => { setRoster(r); setError(null); }).catch((e) => setError((e as Error).message)), [examId]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  if (['not_downloaded', 'downloading', 'failed', 'locked'].includes(examState)) return <div className="card text-sm text-gray-600">The candidate list is inside the encrypted paper. Unlock the paper to open the attendance desk.</div>;
  const rows = (roster?.candidates || []).filter((c) => !q || c.rollNumber.includes(q.toUpperCase()) || c.name.toLowerCase().includes(q.toLowerCase()));
  const selected = roster?.candidates.find((c) => c.candidateId === sel);
  const S = roster?.summary;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="card space-y-3">
        <div className="flex items-center gap-3 text-sm">
          <input className="input" placeholder="Search roll number or name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          {S && <span className="whitespace-nowrap text-gray-600">{S.present}/{S.total} present · {S.absent} absent · {S.allocated} allocated</span>}
        </div>
        {roster && !roster.requireAttendance && <p className="text-xs text-amber-700">Attendance is optional on this server (REQUIRE_ATTENDANCE=false): candidates without attendance can still log in on unallocated PCs.</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <table className="w-full text-sm">
          <thead className="text-left text-gray-500 border-b"><tr><th className="py-1">Roll no.</th><th>Name</th><th>Attendance</th><th>PC</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.candidateId} onClick={() => setSel(c.candidateId)} className={`border-b last:border-0 cursor-pointer ${sel === c.candidateId ? 'bg-primary-50' : 'hover:bg-gray-50'}`}>
                <td className="py-1 font-mono">{c.rollNumber}</td><td>{c.name}</td>
                <td><span className={c.attendance === 'present' ? 'text-green-700' : c.attendance === 'absent' ? 'text-gray-500' : 'text-amber-700'}>{c.attendance}</span></td>
                <td>{c.hostname || c.machineId || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && roster ? <Verify key={selected.candidateId} examId={examId} row={selected} roster={roster} onDone={load} /> : <div className="card text-sm text-gray-500">Select a candidate to verify.</div>}
    </div>
  );
}
