# Agent Games — Proof Gatekeeper: protocol notes (prep, 2026-11-17)

Research + scaffolding only. Nothing registered, deployed, or submitted.
Sources: official event page (agentgames.zkverify.io/events/proof-gatekeeper),
three published build write-ups (amanselalu1991/Medium, mangkarones/dev.to,
dayakdayak1998/Medium), and the two public reference repos studied
read-only (mangkarones3-afk/agent-games-gatekeeper,
subastian1998/agent-games-season-01). Our implementation in this repo is
original code written from the protocol spec — no code was copied.

## 1. Circuit artifacts — downloaded + verified

Source: https://agentgames.zkverify.io/circuits/ (direct file URLs; the
/circuits index itself 404s, files are served directly).

| file | bytes | sha256 |
|---|---|---|
| gatekeeper.wasm | 1,755,820 | be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f |
| gatekeeper_final.zkey | 309,750 | adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d |

Location: `~/workspace/agent-games/circuits/` (master copy) and
`gatekeeper/circuits/` (scaffold copy, gitignored, re-downloaded at boot
if missing). No verification-key JSON is published at /circuits/ — 8
candidate names probed, all 404 (gatekeeper_vk.json, verification_key.json,
gatekeeper_vkey.json, vkey.json, verification-key.json,
gatekeeper.verification_key.json, gatekeeper.circom, gatekeeper.r1cs).
The VK is exported from the zkey at runtime
(`snarkjs.zKey.exportVerificationKey`) — that is what both reference
implementations do.

Local probe results (this VM, snarkjs 0.7.6, downloaded artifacts):
- VK exported: nPublic = 13, curve bn128.
- Valid APPROVE: proof verifies locally, ~389 ms, 13 public signals,
  proof JSON 725 bytes.
- Trap task (recipient mismatch) with correct REJECT: verifies, ~299 ms.
- Wrong decision in either direction (REJECT a valid task, APPROVE a trap):
  witness generation fails at `GatekeeperEvaluation` line 102 assert —
  the circuit enforces the decision, no proof can exist for it.
- Scaffold self-test (`node test.js`): ALL TESTS PASSED — 11 decision
  checks (all traps + boundaries + reuse + retry), APPROVE proof verified
  in 921 ms, REJECT proof in 376 ms, wrong decision fails as required.
- Note: keccak256 of the exported VK JSON is
  0xd8a04114fa8eecbac11cbc6bef67c3cd4af5c38463b7b3fa2fddb6f2b37f487a,
  which does NOT equal the published registered-VK hash
  0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0.
  That hash is a platform-side identifier (derivation unknown); it does
  not affect proof generation — the circuit takes the hash as a plain
  input. Confirm the dashboard shows the same hash after registration.

## 2. Endpoint protocol

Base: plain Node.js `http` server, no framework. One process, one port
(`PORT` env, hosting platforms inject it). Public HTTPS URL on the
standard port (443) — the platform will not accept a tunnel URL that
it cannot reach, or a non-standard port.

### Endpoints

- `GET /health` — readiness JSON: `{ok, agent, hmacConfigured,
  taskIdMode, selfTest}`. The server runs a proof self-test at startup
  (synthetic valid task → APPROVE → real proof → local verify) and
  reports PASS/FAIL here, so a broken deploy announces itself.
- `POST /gatekeeper` — the only scored endpoint.

### Transport security (HMAC, both directions)

- Header: `x-agent-games-signature`.
- Scheme: HMAC-SHA256 over the RAW request/response bytes, keyed by the
  per-agent secret issued by the dashboard ("Rotate Secret",
  `AGENT_GAMES_HMAC_SECRET`). Verify BEFORE JSON parsing — re-serialising
  parsed JSON changes the bytes and breaks verification. Use a
  timing-safe comparison.
- Encoding: lowercase hex by default; `sha256=<hex>` is the fallback
  (`AGENT_GAMES_HMAC_FORMAT`). The official docs do not state the
  encoding explicitly — the preflight is the verification step.
- Every response is signed the same way, including errors (401/400/404/
  500). A request with a bad signature gets 401 and nothing else.
- Without the secret set, inbound verification is disabled (dev mode
  only). The dashboard preflight fails in that state — the exact failure
  seen by another entrant: `FAILED (protocol) — "The endpoint must return
  signed protocol-v1 JSON."`

### Envelope shape

The platform POSTs a signed task envelope. Condition fields are wrapped
in an `input` object; `task_id` stays at envelope level (one entrant
lost live tasks to this: `BigInt(undefined)` threw because the code
expected the fields flat).

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_24_9d1",
  "mode": "competition",
  "issued_at": "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk": "0x7d3a...f291",
    "proof_vk": "0xa4c1...b8ff",
    "minimum": "1000",
    "public_balance": "1460",
    "expiry_block": 19842201,
    "current_block": 19832000,
    "recipient": "0xDe42...9f01",
    "condition_recipient": "0xDe42...9f01",
    "amount": "500",
    "max_transfer": "1000",
    "proof_tx": "0xa4c1...8ff1"
  }
}
```

### Preflight

Envelope `{"type": "agent-games.preflight.v1"}` → respond
`{ok: true, protocolVersion: "v1"}`, signed. The dashboard runs this
before accepting the endpoint; it is also what confirms the HMAC format.

### Decision — the 7-trap checklist (first failing trap wins)

Order matters: a substituted key must be reported as a key problem, not
masked by a downstream failure. The circuit enforces the same
evaluation, so the JS checklist must mirror it bit-exactly.

1. `VK_SUBSTITUTION` — `proof_vk != registered_vk` (case-insensitive
   string compare) → REJECT.
2. `PROOF_REUSED` — same `proof_tx` already seen under a DIFFERENT
   `task_id` → REJECT. A retry of the SAME `task_id` is NOT reuse.
   Track proof refs keyed to the task that first used them.
3. `THRESHOLD_MISMATCH` — `public_balance < minimum` → REJECT.
   Boundary inclusive: balance exactly equal to the minimum is VALID.
4. `EXPIRED_CONDITION` — `current_block >= expiry_block` → REJECT.
   Boundary STRICT: `current_block == expiry_block` is EXPIRED.
5. `RECIPIENT_MISMATCH` — `recipient != condition_recipient`
   (case-insensitive) → REJECT.
6. `AMOUNT_OVERFLOW` — `amount > max_transfer` → REJECT. Boundary
   inclusive: amount exactly at the cap is VALID.
7. Else `VALID_CONDITION` → APPROVE.

Fail closed: any error, timeout, or uncertainty anywhere means REJECT.
Never approve by default. A correct decision without a valid proof
earns no reliability bonus and costs an extra −2, so if proof
generation fails mid-task, still return the decision without a proof
(a visible −2 rather than a hang/timeout).

### Response shape

```json
{
  "decision": "APPROVE",
  "reason_code": "VALID_CONDITION",
  "proof_tx": "0xa4c1...8ff1",
  "proof": {"pi_a": [...], "pi_b": [...], "pi_c": [...],
            "protocol": "groth16", "curve": "bn128"},
  "public_signals": ["...13 values..."]
}
```

- `PROOF_REUSED` responses carry NO proof (the platform excludes them
  from the reliability bonus).
- A retried `task_id` must return the byte-identical cached response.
- `proof`/`public_signals` come from `snarkjs.groth16.fullProve` with
  the official artifacts.

### Circuit inputs (13) and public signals (13)

Inputs: `registeredVkHash, proofVkHash, minimum, publicBalance,
expiryBlock, currentBlock, recipient, conditionRecipient, amount,
maxTransfer, decision` (1 = APPROVE, 0 = REJECT), `taskId`, `salt`
(private, fresh random 32 bytes per proof — it binds each proof so it
cannot be precomputed or replayed as a static artefact).
Public signals: a salt-dependent binding hash first, then the 12 public
task fields in input order (minus salt). The platform checks the 12
public fields against the envelope.

`taskId` mapping: the envelope `task_id` is a string (e.g. `gk_24_9d1`)
and the circuit needs a field element. Default `keccak`:
`keccak256(utf8(task_id)) mod FIELD_PRIME` (BN254 scalar field).
Alternatives via `GATEKEEPER_TASK_ID_MODE`: `numeric` (digits of the
id), `hex` (hex chars). The keccak mapping is what the published
verified implementations use and what practice tasks accepted — but it
is the one protocol item that was openly undocumented, so confirm it
against a practice task after registration and switch mode if the
platform rejects the proof.

### Scoring (official)

- Correct APPROVE (verified): +12. Correct REJECT (verified): +12.
- Incorrect APPROVE: −6. Incorrect REJECT: −3.
- Delivery timeout (no accepted response within 60 s): −2.
- Missing / invalid proof: −2.
- Reliability bonus: +0 to +5, pro-rated by the share of provable tasks
  whose proof verified. PROOF_REUSED tasks have no proof and are excluded.
- Ties: more correct decisions, then fewer timeouts; equal agents share
  the rank and split the prize.
- Rounds: 8 daily rounds, 13–21 Nov, 4:00 PM–2:00 AM IST
  (17:30–03:30 WIB), 8 tasks per agent per round, scores cumulative.
  Round 5 (17 Nov) is already lost; Rounds 6–8 (18–20 Nov) remain.
  Entries lock while a round is open.

### Entry requirements (official)

- Authenticated account + prize-eligibility identity (GitHub linked).
- Registered HTTPS agent endpoint with a passing health check.
- Completed signed preflight + at least one practice task.
- Endpoint responds within 60 s under load. Proof generation is
  ~0.3–0.9 s locally, far inside the window.
- One agent per owner in this event.

## 3. What is scaffolded (original code, protocol spec only)

`~/workspace/agent-games/gatekeeper/`:

| file | what it is |
|---|---|
| `server.js` | HTTP server: GET /health, POST /gatekeeper, HMAC verify/sign, preflight, response cache, startup self-test, circuit download at boot |
| `gatekeeper.js` | The 7-trap decision checklist + proof_tx seen-set handling |
| `lib/hmac.js` | HMAC-SHA256 sign/verify (hex + `sha256=` formats) |
| `lib/field.js` | BN254 field prime, keccak256-mod-p |
| `lib/proof.js` | snarkjs wrapper: VK export from zkey, taskId mapping, circuit input builder, fullProve, local verify |
| `lib/state.js` | Disk persistence for the seen-set + response cache (state.json) |
| `scripts/fetch-circuits.js` | Downloads wasm+zkey at boot if missing; warns if sizes differ from the verified ones |
| `test.js` | Local harness: 11 decision checks + real APPROVE/REJECT proofs + wrong-decision refusal — ALL TESTS PASSED on this VM |
| `package.json` | Node ≥22, deps `snarkjs@^0.7.6`, `js-sha3@^0.9.3`; `npm start` / `npm test` |
| `.env.example` | Env vars with TODOs for the dashboard-issued values |
| `.gitignore` | node_modules, .env, circuits/, state.json |
| `README.md` | Run instructions + status checklist |
| `NOTES.md` | This file |

Deliberate differences from the reference implementations (improvements):
- The proof_tx seen-set + response cache persist to disk (`state.json`)
  instead of memory only, so a restart cannot forget which proofs were
  used (a restart mid-round could otherwise let a replayed proof_tx
  through to an APPROVE, −6).
- No wallet, no keys, no signing of anything on the server — judging
  only. Nothing here ever spends or moves funds.

## 4. Hosting — what can serve this endpoint for free

Requirement: public HTTPS on port 443, always-on during rounds
(17:30–03:30 WIB daily, 18–20 Nov), responds in well under 60 s.
Proven load is tiny: 8 tasks/round, proof ~0.4 s each.

- **Railway — RECOMMENDED.** New accounts: 30-day trial, one-time $5
  credit, no credit card required (verified against Railway pricing
  pages, Nov 2026). Trial caps ~1–2 vCPU / 0.5–1 GB RAM per service —
  far more than this server needs. Deploy from GitHub with auto-deploy;
  this is what both published entrants use
  (`*.up.railway.app`). Costs ~$0.10–0.30 for the 4 remaining days at
  these sizes, inside the $5 credit. Caveats: (a) one pricing review
  notes new signups were paused on 23 Oct 2026 after a security
  incident — verify signup is open before counting on it; (b) the trial
  needs GitHub-account verification for full outbound network access,
  otherwise it is a limited trial; (c) after the trial it drops to a
  $1/month-credit Free plan. Needs: a Railway account (GitHub sign-in)
  + the repo pushed to GitHub.
- **Fly.io — NOT SUITABLE.** No free tier for new organisations since
  Oct 2024. Trial is $1 credit for 7 days, no card — but trial machines
  auto-stop after 5 minutes of running, so it cannot stay up through a
  round. Cheapest always-on machine ~$1.94–2.19/month needs a card.
- **Render Free — RISKY.** 750 free instance hours/month, no card
  required, but free web services sleep after 15 min of inactivity and
  cold-start slowly (commonly 30–60 s+), which can eat the whole 60 s
  response window on the first task of a round. Only viable with an
  external keep-alive pinger, and even then the first cold start after
  a gap is a gamble.
- **Vercel Hobby (serverless) — PLAUSIBLE BUT UNVERIFIED.** No card,
  no sleep (functions spin up per request), the 2 MB of circuit files
  fit the function bundle, and proof generation (~0.4 s) fits even a
  10 s function timeout. Not verified in this session: the exact Hobby
  function timeout/egress behaviour for a wasm-heavy function, and
  whether the platform accepts a serverless URL. Test before relying
  on it.
- **Free tunnels (ngrok free / Cloudflare Tunnel / tunnelmole) — DO NOT
  WORK FROM THIS VM.** Measured by the other entrant on the same
  infrastructure: the VM egress proxy returns 403 for
  api.trycloudflare.com and 502 for tunnelmole; raw SSH is reset.
  A tunnel must run on an unrestricted host (Karina's own PC/VPS), not
  here. Also, a random tunnel URL changes on restart and must be
  re-registered in the dashboard each time.

Recommendation: Railway trial (GitHub sign-in, no card) as primary;
Vercel serverless as the fallback to test. Do NOT pick Fly.io or
Render-free for the live rounds.

## 5. Open questions — only the registered dashboard can answer

1. **HMAC secret** (`AGENT_GAMES_HMAC_SECRET`): issued per agent via
   the dashboard "Rotate Secret". Nothing works live without it.
2. **HMAC encoding**: hex (default) vs `sha256=` — preflight decides.
3. **Registered VK hash**: confirm the dashboard's registered VK hash
   equals 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
   (the value the published implementations use and the docs cite).
4. **taskId mapping**: confirm `keccak` against a practice task; switch
   `GATEKEEPER_TASK_ID_MODE` to `numeric`/`hex` if the platform rejects
   the proof.
5. **zkVerifyJS**: the official build checklist says step 02 is "Call
   zkVerifyJS to confirm the proof is on-chain and its VK matches the
   registered condition VK" — but NEITHER working, platform-verified
   implementation calls zkVerifyJS anywhere (no such dependency in
   either repo; decisions are purely envelope-field checks + the local
   Groth16 proof, which the platform re-verifies). Either the on-chain
   check is aspirational documentation, or it is a step the dashboard
   will show. Check the dashboard/docs after registration; do not add
   the dependency until then.
6. **INVALID_TASK scoring**: our server returns REJECT with
   reason_code `INVALID_TASK` for envelopes missing required fields
   (a local guard, not one of the 7 official codes). Unknown how the
   platform scores it — presumably as a wrong rejection (−3) at worst.
   Real tasks should never be malformed.
7. **Endpoint registration details**: exact dashboard fields (just the
   base URL or the full `/gatekeeper` path? health-check URL?).
   Reference entrants registered the full handler path
   (`https://<host>/gatekeeper`).
8. **Practice mode**: where the practice task is triggered in the
   dashboard, and whether practice tasks use the same envelope shape
   (one entrant found the live envelope wraps fields in `input` while
   their test fixtures were flat — test against the wire).

## 6. Registration status (from the parent, 2026-11-17)

- X handle: **@dhilee12**. Registration is via X OAuth or wallet
  connect (RainbowKit) only — the site cannot create a new wallet, and
  no wallet was detected in the cloud browser.
- **BLOCKED 2026-11-17 ~17:23 WIB:** X temporarily rate-limited the
  login ("Kami membatasi proses masuk Anda sementara waktu") after
  several username attempts; X authorisation unfinished, handle
  unclaimed, GitHub not yet linked. Retry after the limit lifts, or
  via wallet connect (QR scanned from a phone).
- Steal the VFY is skipped (Swiss started 13 Nov, late entry reported
  locked). Creator Track is the parallel no-code entry: an article /
  thread documenting this build, with #AgentGames + @ZKVProtocol.
- Gatekeeper leaderboard: 471 agents, none named dhilee12 (handle
  availability not yet verified — the claim happens at registration).
