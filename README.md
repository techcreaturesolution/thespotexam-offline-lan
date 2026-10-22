# thespotexam-offline-lan

Offline-first LAN exam system for thespotexam.com (Windows exam centers).

```
thespotexam.com cloud (MERN)  ⇄  internet, before/after the exam
        Center Server (this repo: center-server/, Windows service)
        ⇄  LAN only during the exam
Candidate Clients (this repo: candidate-client/, .NET 8 WPF — phase 3)
```

The cloud side (center registration, signed+encrypted paper packages, result ingestion) lives in
`techcreaturesolution/exam-saas-secure-platform` (`docs/offline-lan/`).

| Phase | Status |
|---|---|
| 1. Cloud APIs + center registration | done (cloud repo PR #9–#11) |
| 2. Center Server: activation, paper download/verify/lock, unlock, LAN API, timer, audit | this repo, `center-server/` |
| 3. Candidate Client (.NET 8 WPF, kiosk) | pending |
| 4. Sync engine (signed result batches, retry, ack) | pending |
| 5. Admin dashboard, Windows service, MSI/EXE, auto-update | pending |
| 6. Hardening + offline scenario tests | pending |

See [center-server/README.md](center-server/README.md).
