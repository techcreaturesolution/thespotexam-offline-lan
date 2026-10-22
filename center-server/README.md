# Center Server

Node.js (≥ 22.13, uses built-in `node:sqlite`) + Express + SQLite (WAL, `synchronous=FULL`).

```bash
npm install
npm run dev          # tsx watch; CENTER_TLS=false for plain HTTP during development
npm run lint && npm run typecheck && npm test
npm run build && npm start
npm run demo         # mock cloud + Center Server with an unlocked demo exam (for client development); DEMO_AUTOSTART=1 starts it
```

## Configuration

Env vars, or `config.json` in the data dir (`%ProgramData%\TheSpotExam\CenterServer` on Windows, `~/.thespot-center` elsewhere; override with `CENTER_DATA_DIR`).

| Key / env | Default | Purpose |
|---|---|---|
| `cloudUrl` / `CLOUD_URL` | `https://api.thespotexam.com/api/v1` | Cloud API base |
| `lanIp` / `LAN_IP` | first non-internal IPv4 | Static LAN IP advertised to clients and put in the TLS cert |
| `port` / `CENTER_PORT` | 8443 | HTTPS port |
| `discoveryPort` / `DISCOVERY_PORT` | 41234 | UDP discovery (`THESPOT_DISCOVER_V1` probe) |
| `tls` / `CENTER_TLS` | true | Self-signed cert; clients pin the SHA-256 fingerprint |
| `autoSubmitGraceSeconds` | 15 | Grace after time-up before auto-submit |
| `clientTimeoutSeconds` | 30 | No heartbeat for this long ⇒ PC shown as disconnected |
| `lateSyncWindowSeconds` | 600 | Window to accept queued answers from a PC that was disconnected at auto-submit (marked `late`) |
| `retentionDays` | 30 | Days to keep candidate data and the package after the exam is fully synced |
| `syncIntervalSeconds` | 30 | How often the sync engine checks for work / internet |
| `syncBatchSize` | 50 | Attempts per signed result batch (cloud max 100) |
| `syncBackoffBaseSeconds` / `syncBackoffMaxSeconds` | 15 / 900 | Exponential retry backoff (±20 % jitter) |

## Flow

1. **Admin setup** – `POST /admin/setup` (only from the server PC itself), then `POST /admin/login`.
2. **Activate** – `POST /admin/activate {centerCode, activationKey}`. Generates the center Ed25519 key pair, binds the hardware fingerprint, stores the per-center API token sealed with the local master key, and pins the cloud signing key.
3. **Download** – `POST /admin/sync-papers`. Resumable (HTTP Range) download; verifies the file SHA-256 against the manifest, the Ed25519 header signature against the pinned cloud key, the ciphertext hash and the exam/center binding. The package stays encrypted on disk (**locked**).
4. **Unlock** – `POST /admin/exams/:examId/unlock {releaseCode}` (OTP mode, works offline) or without a code in online mode (cloud releases the key only after `keyReleaseAt`). The key is sealed locally so a restart doesn't need the code again; the plaintext paper lives only in memory.
5. **Login + start** – candidates log in (roll number + access code from the cloud CSV) once unlocked; `POST /admin/exams/:examId/start` starts the timer.
6. **Run** – pause / resume / extend (whole exam or one roll number) / reset-candidate / end, all written to the hash-chained audit log.
7. **Sync** – automatic, see below.

## Result sync (phase 4)

`src/sync.ts` runs every `syncIntervalSeconds`:

1. **Build** – once an exam is `ended`, every attempt is final and the late-sync window has closed, it checks the answer-row MACs and the audit chain (upload is **blocked** if either fails), then writes the results into batches of `syncBatchSize` attempts (answers, violations, timing, per-attempt `idempotencyKey`). Each batch's exact JSON string, its SHA-256 and its Ed25519 signature (center key) are stored in `sync_batches`. The last batch has `isFinal` and the summary counts the cloud reconciles against.
2. **Upload** – when the cloud is reachable, `POST /results/upload {payload, signature}`. Before sending, the stored batch is re-verified against its own signature (a batch edited on disk is never sent). Retries resend the identical bytes, so a crash, timeout or lost ack just gets the cloud's replayed ack — no double counting.
3. **Ack** – a batch / attempt is marked synced only after the cloud ack's Ed25519 signature (pinned cloud key), `batchId`, `centerCode` and `payloadSha256` all check out. Per-attempt results (`accepted` / `duplicate` / `rejected`) are kept.
4. **Retry** – network errors and 5xx/401/408/429 retry with exponential backoff; other 4xx mark the batch `error` until the operator calls `POST /admin/sync/run`.
5. **Retention** – `retentionDays` after an exam is fully synced, its attempts, answers, violations, batch payloads, package file and paper key are deleted (the audit log is kept).

`GET /admin/sync` shows per-exam status (`waiting`, `blocked`, `pending`, `in_progress`, `synced`, `synced_with_rejections`, `error`), batch tries / next retry / last error, and local vs cloud-acked counts. The heartbeat reports `pendingSyncBatches` to the cloud admin page.

## Timer

The exam's `elapsed_ms` is persisted every second and advanced only by this process's monotonic clock while the exam is running (ticks are capped at 5 s, so sleep/suspend can't burn time). Candidate PC clocks and wall-clock changes have no effect. Remaining time = duration + exam extra + candidate extra − elapsed. After a crash the timer resumes from the last checkpoint.

## LAN API (candidate client)

Headers: `X-Machine-Id`, `X-Machine-Token` (from `/client/register`), and `Authorization: Bearer <sessionToken>` after login. Sessions are bound to the PC; a candidate can only move to another PC after an invigilator reset.

| Method | Path | Notes |
|---|---|---|
| GET | `/client/discover` | Server info + cert fingerprint |
| POST | `/client/register` | `{machineId, hostname, clientVersion}` → `machineToken`; re-register needs the old token or an admin reset |
| POST | `/auth/login` | `{rollNumber, password, examId?}` |
| POST | `/auth/logout` | |
| GET | `/exam/state` | server time, remaining seconds, paused, attempt status |
| GET | `/exam/questions` | after start; per-candidate seeded shuffle; no answer keys; includes saved answers for resume |
| POST | `/answers/save` | `{answers:[{questionId, answer, flagged, version, timeTakenSeconds}]}`; only higher `version` wins (safe for retries/out-of-order) |
| POST | `/exam/submit` | optional final answers; idempotent |
| POST | `/violations/log` | `{violations:[{type, detail, at}]}` |
| POST | `/heartbeat` | returns state |

## Admin API

`/admin/status`, `/admin/activate`, `/admin/sync-papers`, `/admin/exams/:id/{unlock,start,pause,resume,extend,end,reset-candidate}`, `/admin/machines/:id/reset`, `/admin/exams/:id/live`, `/admin/exams/:id/verify` (answer-row MACs + audit chain), `/admin/violations`, `/admin/audit`, `/admin/sync`, `/admin/sync/run`.

## Tamper detection

- Package: re-verified (file hash + signature) each time it is opened.
- Answers: every row carries an HMAC keyed by the local master key; `/verify` reports edited rows.
- Audit log: SHA-256 hash chain; `/verify` reports the first broken entry.
