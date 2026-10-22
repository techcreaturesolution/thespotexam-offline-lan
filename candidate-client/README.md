# TheSpot Exam — Candidate Client (Phase 3)

Windows exam client for the offline LAN exam system. It talks **only** to the Center Server on the local network
(HTTPS with a pinned certificate); no internet access is needed or used during the exam.

```
cloud (MERN)  <->  Center Server (center-server/, Node + SQLite)  <->  Candidate Client (this folder) over LAN
```

Stack: .NET 8, WPF, BCL only (no local database engine, no third-party runtime packages). Tests use xUnit.

| Project | Contents |
|---|---|
| `TheSpot.CandidateClient` | WPF app: connect / login / waiting / exam / submitted screens, kiosk controller |
| `TheSpot.CandidateClient.Core` | No WPF. Pinned HTTPS API client, UDP discovery, DPAPI + AES-GCM secure store, machine identity, answer book (versioned answers + violation queue), monotonic server clock, `ExamSession` sync loop, key policy |
| `TheSpot.CandidateClient.Tests` | xUnit: crypto/tamper, versioning/queue, timer vs wall clock, session (offline, restart, timeout, late sync), live API integration |

## Build and test

```bash
cd candidate-client
export PATH=/c/dotnet:$PATH DOTNET_NOLOGO=1   # wherever the .NET 8 SDK lives
dotnet build
dotnet test
```

The integration tests (`IntegrationTests.cs`) run against a live Center Server. They use
`THESPOT_IT_HOST` / `THESPOT_IT_PORT` if set, otherwise UDP discovery, and are **skipped** when no server answers.
To run them locally start the demo first: `cd center-server && npm install && npm run demo`.

## Publish (single file, self-contained, win-x64)

```bash
dotnet publish TheSpot.CandidateClient -p:PublishProfile=win-x64
# -> candidate-client/publish/win-x64/TheSpot.CandidateClient.exe (+ client.sample.json)
```

The exe needs no .NET install on the candidate PC. `publish/`, `bin/` and `obj/` are git-ignored.

## Configuration

`client.json` is read from the first of: `%THESPOT_CLIENT_CONFIG%`, `%ProgramData%\TheSpotExam\CandidateClient\client.json`,
`client.json` next to the exe. See `TheSpot.CandidateClient/client.sample.json` (comments allowed). All keys are optional.

| Key | Meaning |
|---|---|
| `serverHost`, `serverPort` | Preset Center Server address. Without it the Connect screen offers LAN discovery / manual IP:port. |
| `serverFingerprint` | Preset SHA-256 certificate pin (as printed by the Center Server). Skips on-screen confirmation. |
| `discoveryPort` | UDP discovery port (default 41234). |
| `autosaveSeconds`, `debounceMilliseconds` | Autosave period (default 5 s) and answer-change debounce (default 800 ms). |
| `invigilatorPasswordHash` | PBKDF2-SHA256 hash of the invigilator password. Generate with `TheSpot.CandidateClient.exe --hash-password "<password>"`. Never store the plaintext. Required to exit kiosk mode, change server, or confirm a new pin. If unset, those actions are refused. |
| `dataDir` | Local data directory (default `%LOCALAPPDATA%\TheSpotExam\CandidateClient`, env `THESPOT_CLIENT_DATA` overrides). Use forward slashes or escaped backslashes in JSON. |
| `kiosk.enabled`, `blockKeys`, `excludeFromCapture`, `clearClipboard` | Kiosk switches (all default `true`). |

## How it works

- **Connect + pinning.** UDP broadcast `THESPOT_DISCOVER_V1` to port 41234, or manual IP:port (the client then reads the
  presented certificate). The SHA-256 fingerprint is shown and must be confirmed by the invigilator (password), then is
  stored encrypted. Every HTTPS connection checks the pin; a mismatch is refused (no trust-all fallback). Changing the pin
  requires the invigilator ("Change server").
- **Machine identity.** `pc-<sha256(MachineGuid)>` (fallback: machine name), registered once via `POST /client/register`;
  the machine token and the candidate session token are stored only inside the encrypted store.
- **Local store.** Files are AES-256-GCM (`TSC1` header, random 12-byte nonce, 16-byte tag, file name bound as AAD), written
  atomically. The 32-byte key is protected with DPAPI (current user). A tampered or swapped cache file is rejected and
  quarantined (`*.bad-<utc timestamp>`) instead of being trusted.
- **Answers.** Each change bumps that question's version; the pending queue is every answer with `version > ackedVersion`,
  persisted on every change. Saves go to `POST /answers/save` every 5 s and ~0.8 s after a change. The server keeps only the
  highest version, so retries and out-of-order delivery are safe. On login, server-held answers are merged (higher version
  wins) and anything the server does not hold is uploaded again.
- **Offline.** If the Center Server is unreachable the exam continues locally, the header shows **Offline** with the pending
  count, and the queue (answers + violations) is flushed on reconnect.
- **Timer.** The countdown is the server's `remainingSeconds`, advanced between syncs with the monotonic `TimeProvider`
  timestamp (Stopwatch); `DateTime.Now` is never used for it, so Windows clock changes have no effect. It is frozen while the
  exam is not running (waiting/paused).
- **Resume.** After a crash/restart the candidate logs in again on the same PC; answers, flags, current question and pending
  queue come from the encrypted cache and the remaining time from the server.
- **Submit.** Manual submit asks for confirmation. When the server reports time up the client submits automatically with the
  queued answers. If the server already finalised the attempt (e.g. auto-submit while this PC was offline) the client shows the
  final status and flushes queued answers while the server's late-sync window is open. `POST /exam/submit` is idempotent.

## Kiosk mode — what it does and its limits

Best effort from **user mode**:

- Borderless, fullscreen, topmost window; re-activated when it loses focus.
- Low-level keyboard hook (`WH_KEYBOARD_LL`) blocks Alt+Tab, Win keys, Alt+F4, Alt+Esc, Ctrl+Esc, Ctrl+Shift+Esc,
  PrintScreen, the context-menu key, Ctrl+C/X/V and Ctrl/Shift+Insert. Each blocked key is logged via `POST /violations/log`
  (queued while offline).
- Copy/cut/paste commands are disabled in the UI and the clipboard is cleared periodically.
- `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (fallback `WDA_MONITOR`) so screenshots/recordings show the window blank.
- Window deactivation (focus loss) is logged as a violation.
- Invigilator exit: **Ctrl+Alt+Shift+F12**, then the invigilator password (checked against the configured hash). Wrong
  passwords are logged.

Limits (cannot be enforced from a user-mode app):

- **Ctrl+Alt+Del cannot be blocked** (secure attention sequence handled by Windows). From that screen a candidate can reach
  Task Manager, lock, sign out or switch user. Disable these with Group Policy (e.g. *Remove Task Manager*,
  *Remove Lock Computer*, *Remove Change Password*, *Hide Fast User Switching*) or use Windows Assigned Access / Shell
  Launcher on exam PCs.
- Hardware/firmware keys, a second monitor, a hardware capture device, a phone camera, or a remote session/VM host are not
  controlled by the client. Screen-capture exclusion depends on the Windows version (Windows 10 2004+ for
  `WDA_EXCLUDEFROMCAPTURE`) and on the capture tool honouring it.
- Running the exe as a normal user means an administrator can kill it; run candidate sessions under a restricted local account.
- Network isolation (no internet) must be enforced by the center's network/firewall; the client simply never contacts
  anything except the pinned Center Server.
