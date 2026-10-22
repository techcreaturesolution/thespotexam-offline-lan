# Phase 3 test report — WPF Candidate Client

Date: 2026-10-22. Machine: Windows Server 2022 (single VM, 1600x1200 desktop), .NET SDK 8.0.426, Node 22.20.0.
Center Server: `npm run demo` harness (`center-server/scripts/demo.ts`, mock cloud + real HTTPS Center Server on
`https://172.16.255.2:8443`, UDP discovery :41234). Client: self-contained `publish/win-x64/TheSpot.CandidateClient.exe`
with a test `client.json` (hashed invigilator password, `dataDir` under `C:/thespot-demo/client-data`).
Client and server ran on the **same** machine, so "LAN" traffic went over the local interface, not a real network.

Screenshots/JSON referenced below are attached to the PR conversation (file names as listed); they are not committed.

## Automated

| Check | Result |
|---|---|
| `dotnet build` (warnings as errors) | PASS |
| `dotnet test` with the demo server running | PASS — 34/34 (incl. live integration: register, login, questions, versioned + stale save, violation log) |
| `dotnet test` without a server | integration tests are skipped (by design) |
| `center-server`: `npm run lint && npm run typecheck && npm test` (after the `scripts/demo.ts` change) | PASS — 12/12 |

Unit coverage: AES-GCM cache round trip, ciphertext does not contain plaintext, tamper / truncation / file-swap rejection,
DPAPI round trip, PBKDF2 password hash, fingerprint normalisation, key policy (blocked combos + hidden exit combo),
per-question versioning / ack / pending queue / restart persistence / tamper quarantine, merge with server answers
(including re-upload of answers the server does not hold), monotonic timer unaffected by wall-clock jumps (fake
`TimeProvider`), timer frozen while paused / not started, session: LAN drop queue + flush, crash-restart resume, local
time-up auto-submit, server auto-submitted while offline + late sync, manual submit idempotence.

## Manual UI scenarios (against `npm run demo`)

| # | Scenario | Result | Evidence |
|---|---|---|---|
| a | UDP discovery finds the server, invigilator confirms fingerprint, pinned HTTPS, login R001 | PASS | `a1-discovery.png`, `a2-pinned-login.png`, `a3-exam.png` |
| a′ | Manual IP:port entry shows the presented fingerprint for confirmation | PASS | `a5-manual-entry-fingerprint.png` |
| a″ | Server with a different certificate (new demo data dir) is refused while the old pin is stored | PASS | `a4-pin-mismatch-refused.png` |
| b | Answer questions; `GET /admin/exams/<id>/live` shows the answered count | PASS — server `answered: 2` after 2 answers | `b1-answered-flagged.png`, `b2-live.json` |
| c | Kill the client process mid-exam (`taskkill /F`), relaunch, log in again: answers, flag, current question and remaining time intact | PASS | `c1-resumed.png`, `c2-answer-restored.png` |
| d | Stop the Center Server, keep answering: header shows Offline + pending count; restart with the same `CENTER_DATA_DIR`: queue flushes | PASS — server `answered: 3` after restart | `d1-offline.png`, `d2-back-online.png`, `d3-live-after-flush.json` |
| e | Change the Windows clock +1 h and −1 h during the exam: countdown continues unchanged | PASS | `e1-clock-plus1h.png`, `e2-clock-minus1h.png` |
| f | Alt+Tab, Win, PrintScreen, Ctrl+C (also Alt+F4, Ctrl+Esc) blocked; focus loss detected; all appear in `GET /admin/violations` | PASS | `f1-blocked-keys.png`, `f2-violations.json` (alt_tab, win_key, print_screen, copy, alt_f4, ctrl_esc, focus_lost) |
| g1 | Manual submit with confirmation dialog | PASS — server status `submitted`, `answered: 3` | `g1-submit-confirm.png`, `g2-submitted.png`, `g3-live-submitted.json` |
| g2 | Auto-submit at timeout (`DEMO_MINUTES=2`) | PASS (client submitted at time-up; see notes) | `g4-auto-submitted.png`, `g5-live-auto.json`, client log `finished submitted auto=True` |
| h | Invigilator exit: Ctrl+Alt+Shift+F12 → password prompt; wrong password refused and logged; correct password closes the client | PASS | `h1-invigilator-exit.png`, `h2-invigilator-wrong.png` |
| i | Same PC, replaced Center Server (fresh data dir, same exam id): after re-pinning, cached answers are re-uploaded | PASS (after fix below) — server `answered: 3` | `i1-replaced-server-discovery.png`, `i2-replaced-server-resumed.png`, `i3-live-reuploaded.json` |

## Bugs found during manual testing (fixed in this PR)

1. Hidden exit combo did not fire: `LLKHF_ALTDOWN` is not set when Ctrl is also held. Alt is now also read with
   `GetAsyncKeyState(VK_MENU)`. Re-tested: PASS (h).
2. Countdown ran while the exam was still waiting to start (`g0-waiting.png` shows 01:56 before the start). The clock is now
   frozen unless the server reports `examState: running`. Covered by a unit test; **not re-checked in the UI**.
3. In run g2 the client restored 3 cached answers from an earlier server with the same exam id; they were marked as
   already acknowledged, so the new server only received 1 (`g5-live-auto.json`: `answered: 1`). Login merge now re-queues
   every local answer the server does not hold. Re-tested in scenario i: PASS.
4. Finished screen said "Exam submitted" after a time-up submit; it now says "Time is up … submitted automatically".
   Not re-checked in the UI.
5. Invalid `client.json` crashed the app; it now shows a message and exits.

## Notes and what could NOT be verified

- **Auto-submit status:** when the client is online at time-up it calls `POST /exam/submit` itself, so the server records
  `submitted` (not `auto_submitted`); the server only writes `auto_submitted` when its own grace period expires (client
  offline). The client-side "server auto-submitted while offline → late sync" path is covered by unit tests with a fake
  server only; it was **not** exercised against the real demo server.
- **Screen-capture exclusion** (`WDA_EXCLUDEFROMCAPTURE`) was not independently verified: my screenshots are taken by the
  VM harness outside the guest's capture APIs, so the window still appears in them. PrintScreen itself is blocked (f).
- **Ctrl+Alt+Del** cannot be blocked from user mode (documented in `candidate-client/README.md`); not tested.
- **MCQ multiple choice:** the demo paper only has single-choice questions, so the multiple-choice (checkbox) UI was not
  exercised manually.
- **Resolutions:** only tested on the VM's 1600x1200 desktop; 1366x768 and 1920x1080 were
  not tested on real displays.
- **Real LAN / multiple PCs:** client and server ran on one machine; broadcast discovery across a real switch, several
  candidate PCs at once, and Wi-Fi drops were not tested.
- **Real crash:** the crash was simulated with `taskkill /F`; power loss / OS crash was not tested (writes are atomic and
  write-through, but that was not proven under power loss).
- Windows clock was moved back by hand after (e); Windows Time resync was not verified.
- No screen recording was made; evidence is screenshots + JSON captures.
