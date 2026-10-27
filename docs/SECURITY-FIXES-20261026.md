# Security and concurrency fixes — 2026-10-26

This update addresses the six findings from the local code review:

- LiveTalking verifies the application's short-lived avatar ticket against the backend `/api/avatar/identity` endpoint. Student controls require session ownership; administrative and non-allowlisted routes require an administrator. Student offers cannot override avatar configuration. Authentication failures deny access.
- The backend signs avatar-only tickets valid for 120 seconds; the browser refreshes them after 60 seconds. These tickets cannot authenticate normal application APIs. The browser supplies authentication to avatar HTTP calls and ASR WebSocket handshakes. WebSocket credentials use a subprotocol header, not a URL query; the negotiated protocol is `asr` so the token is not selected or logged as an unsupported protocol. Do not log Authorization or Sec-WebSocket-Protocol headers in infrastructure.
- Login JWTs require `purpose=access`. Interruption notification JWTs cannot authenticate normal API requests. Existing login tokens without this purpose require signing in again after restart.
- Registration attempts are limited per IP across usernames. Successful registrations do not reset the window.
- Deleted interviews no longer leave blocking interruption foreign keys. Recent interruption timestamps move atomically to a minimal user/time ledger, preserving cooldown enforcement without retaining interview content. Expired ledger entries are pruned at startup, matching existing interruption retention. The new table is created by the existing startup schema initialization; old tables do not need rebuilding.
- A coordinator reuses same-name lock objects through a guarded weak registry. References waiting to acquire keep the same lock alive, including after operation-lock cache cleanup; budget checks also use that same lock. Unreferenced locks are reclaimable.

## Rollout

Deploy the backend, frontend and updated LiveTalking patch together. Restart both backend and LiveTalking and rebuild the frontend. Existing avatar sessions must reconnect because older sessions have no authenticated owner. Authentication checks use `http://127.0.0.1:8000/api/avatar/identity`; set `INTERVIEW_AUTH_URL` only when the backend uses another trusted internal address. Never point it to an untrusted service: it receives short-lived avatar tickets.

The application backend must be reachable before avatar connections can authenticate. `/healthz` remains available without authentication for readiness checks. Direct use of the upstream unauthenticated web UI is intentionally disabled; use the authenticated interview frontend. The public proxy must forward Authorization and Sec-WebSocket-Protocol headers (Nginx does so by default); keep LiveTalking bound to loopback as in the supplied launcher.

Keep the development project and the public release checkout separate. The exact LiveTalking changes are tracked as `release/patches/livetalking-local.patch`, pinned to the upstream revision documented by the exporter. Apply it to that revision in a clean checkout; do not apply it again to an already patched working integration.

## Validation

Regression coverage includes interrupted interview deletion with foreign keys enabled and cooldown retained, scoped JWT rejection, registration across different usernames, independent budget lock callers and stale operation-lock references. Avatar middleware tests exercise actual aiohttp HTTP/WebSocket requests with a fake identity endpoint and fake sessions, without GPU models. Run them with aiohttp and a patched LiveTalking checkout available; release-only checkouts skip that integration test explicitly.

Passing these tests establishes the specific regressions, not production load capacity or real camera/ASR/TTS/WebRTC operation. Existing review findings outside these six remain outside this change.


## Full-chain test fixes

Windows WSL launch options must remain unquoted; script paths retain native quoting. Shell scripts are checked out with LF endings through `.gitattributes`.

For the Windows backend + WSL avatar development layout, the launcher selects `INTERVIEW_AUTH_MODE=local-ticket` and provides `INTERVIEW_PROJECT_ROOT`. The avatar reads only signing configuration and verifies avatar-only tickets, not the live Windows SQLite database. User authorization is checked by the backend when tickets are issued. Changes to account access can take up to the ticket's remaining 120 seconds to affect a new avatar handshake; existing WebSocket sessions remain authorized for their connection lifetime. Production continues to use the internal identity endpoint and current database roles. Never enable the development verifier in production.

Install the pinned supplementary runtime dependencies in the LiveTalking environment with `python -m pip install -r scripts/livetalking-extra-requirements.txt`. This includes PyJWT and edge-tts 7.3.1. The installed 7.2.8 version failed live synthesis with HTTP 403; upstream 7.3 introduced the updated handshake. Upstream release: https://github.com/rany2/edge-tts/releases/tag/7.3.1.

If the configured proxy is unavailable but direct API access works, include `api.deepseek.com` in `NO_PROXY`. Remove that exception if your network requires a proxy for this service. The local test adjusted only the project environment, not subscription rules or Windows networking.

When no real avatar speech starts, the interview UI now falls back to browser speech instead of silently treating the request as completed. This fallback is separate from successful real-time avatar TTS and must be reported as such during testing.


SenseVoice now checks existing local ModelScope snapshots before trying the model hub and disables automatic update checks. `SENSEVOICE_MODEL_DIR` and `SENSEVOICE_VAD_DIR` allow explicit local model locations. ASR model/inference failures return `asr_unavailable` with `retryable=true`; they no longer become empty transcriptions that could count against the candidate. First model load can take tens of seconds; warm the model before a live demonstration.

Reports repaired from invalid model output now persist `generation_status=repaired` and an explicit notice. The notice is also included in the export disclaimer; locally filled scores must not be presented as a complete model assessment.
