# Agent Games — Proof Gatekeeper agent

Entry for **zkVerify Agent Games, Season 01** (21 Oct – 21 Nov 2026,
400,000 VFY pool, 100,000 VFY per track). Participant: Karina (@dhilee12).

`POST /gatekeeper` receives a signed task envelope from the platform,
verifies the HMAC over the raw body, applies the deterministic 7-trap
checklist (VK substitution, proof reuse, threshold, strict expiry,
recipient, amount overflow), and answers with the decision plus a Groth16
proof generated locally with snarkjs and the official circuit artifacts
(`circuits/`, VK hash `0x6b79c6…d77b0`). Responses are signed with
`x-agent-games-signature`. Scoring: correct +12, wrong APPROVE −6, wrong
REJECT −3, timeout/missing proof −2, reliability bonus +0..+5. Rounds:
8 tasks per agent per daily round, 13–21 Nov, 17:30–03:30 WIB; entries
close 21 Nov 22:00 UTC.

## Run

```bash
npm install
cp .env.example .env   # fill AGENT_GAMES_HMAC_SECRET after dashboard registration
node server.js         # or: PORT=8080 node server.js
node test.js           # decision harness + real proof verification
```

Circuits download automatically at boot if missing
(`scripts/fetch-circuits.js`); they are gitignored, not committed.

## Status / open items

- [x] Decision logic + proof generation, scaffolded (local verification
      pending — see NOTES.md for the probe result)
- [ ] Dashboard registration (Karina signs in with X @dhilee12; link
      GitHub Dhilee22 for prize eligibility)
- [ ] Public HTTPS hosting for the endpoint (see NOTES.md — Railway trial
      is the recommended free path; free tunnels do not work from this VM)
- [ ] Paste dashboard HMAC secret into .env, restart
- [ ] Preflight + practice task — confirms HMAC format and the taskId
      mapping (`GATEKEEPER_TASK_ID_MODE`); switch mode if proof rejected
- [ ] Steal the VFY: skipped — Swiss rounds started 13 Nov, late entry
      reported locked. Creator Track: document this build publicly.

See NOTES.md for the full protocol, hosting comparison, and the list of
things only the registered dashboard can answer.
