// Proof Gatekeeper agent — zkVerify Agent Games Season 01.
// Plain Node.js http server, no framework. Endpoints:
//   GET  /health     -> readiness: HMAC configured? self-test result?
//   POST /gatekeeper -> signed task envelope in, signed decision + proof out
//
// Behaviour:
// - Inbound HMAC is verified over the RAW body before JSON parsing, when
//   a secret is configured (AGENT_GAMES_HMAC_SECRET from the dashboard).
// - Every response is signed with x-agent-games-signature over its raw body.
// - Preflight envelopes {"type":"agent-games.preflight.v1"} are answered
//   {ok:true, protocolVersion:"v1"}.
// - The platform wraps condition fields in an `input` object inside the
//   envelope; task_id stays at envelope level. Decide/prove work on the
//   flat shape.
// - PROOF_REUSED answers carry no proof (the platform excludes them from
//   the reliability bonus). If proof generation ever fails, the decision is
//   still returned without a proof rather than crashing (a visible -2
//   instead of a hang/timeout).
// - Fail closed everywhere: any error or uncertainty means REJECT.
// - A retried task_id returns the byte-identical cached response.
// - The proof_tx seen-set + response cache persist to disk (STATE_FILE),
//   so a restart does not forget which proofs were already used.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { signatureFor, verifySignature } = require('./lib/hmac');
const { decide } = require('./gatekeeper');
const { proveTask, verifyLocally } = require('./lib/proof');
const stateStore = require('./lib/state');

// ---- tiny .env loader (no dependency) ----
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env — env vars only */ }
})();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const HMAC_FORMAT = process.env.AGENT_GAMES_HMAC_FORMAT || 'hex';
const TASK_ID_MODE = process.env.GATEKEEPER_TASK_ID_MODE || 'keccak';
const STATE_PATH = stateStore.defaultPath();

// TODO (dashboard): the registered verification-key hash the platform
// re-verifies proofs against. The value below is the hash published in the
// verified build write-ups (0x6b79c6…d77b0); confirm it matches the VK hash
// shown in the dashboard after registration.
const VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

const state = stateStore.load(STATE_PATH);
let selfTest = 'pending';

async function runSelfTest() {
  const task = {
    task_id: 'selftest_1',
    registered_vk: VK_HASH,
    proof_vk: VK_HASH,
    minimum: '1000',
    public_balance: '1460',
    expiry_block: '8430000',
    current_block: '8420000',
    recipient: '12345',
    condition_recipient: '12345',
    amount: '500',
    max_transfer: '1000',
    proof_tx: '0xselftest',
  };
  try {
    const { decision } = decide(task, new Map());
    const { proof, publicSignals } = await proveTask(task, decision, TASK_ID_MODE);
    const ok = await verifyLocally(publicSignals, proof);
    selfTest = ok && decision === 'APPROVE' ? 'PASS' : 'FAIL (proof did not verify)';
  } catch (e) {
    selfTest = 'FAIL (' + e.message + ')';
  }
  console.log('[selftest] gatekeeper proof self-test:', selfTest);
}

function sendSigned(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  if (HMAC_SECRET) {
    headers['x-agent-games-signature'] = signatureFor(HMAC_SECRET, body, HMAC_FORMAT);
  }
  res.writeHead(status, headers);
  res.end(body);
}

async function handleGatekeeper(envelope) {
  const taskId = String(envelope.task_id || '');
  // Platform retries must get the byte-identical cached response.
  if (taskId && state.responses.has(taskId)) {
    return state.responses.get(taskId);
  }
  // Platform envelopes wrap the condition fields in `input`.
  const input = envelope && typeof envelope.input === 'object' && envelope.input ? envelope.input : {};
  const task = { ...input, task_id: taskId };

  const { decision, reason_code } = decide(task, state.seenProofTx);
  const out = { decision, reason_code };
  if (task.proof_tx) out.proof_tx = task.proof_tx;

  if (reason_code !== 'PROOF_REUSED') {
    try {
      const { proof, publicSignals } = await proveTask(task, decision, TASK_ID_MODE);
      out.proof = proof;
      out.public_signals = publicSignals;
    } catch (e) {
      console.error('[gatekeeper] proof failed for', taskId, e.message);
      out.proof_error = 'proof generation failed';
    }
  }

  if (taskId) {
    state.responses.set(taskId, out);
    stateStore.save(STATE_PATH, state);
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendSigned(res, 200, {
      ok: true,
      agent: 'proof-gatekeeper',
      hmacConfigured: Boolean(HMAC_SECRET),
      taskIdMode: TASK_ID_MODE,
      selfTest,
    });
  }

  if (req.method === 'POST' && req.url === '/gatekeeper') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      if (HMAC_SECRET && !verifySignature(HMAC_SECRET, raw, req.headers['x-agent-games-signature'], HMAC_FORMAT)) {
        return sendSigned(res, 401, { ok: false, error: 'bad signature' });
      }
      if (!HMAC_SECRET) {
        console.warn('[warn] AGENT_GAMES_HMAC_SECRET is not set — inbound HMAC is NOT verified. Set it before going live.');
      }
      let envelope;
      try {
        envelope = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendSigned(res, 400, { ok: false, error: 'invalid json' });
      }
      if (envelope && envelope.type === 'agent-games.preflight.v1') {
        return sendSigned(res, 200, { ok: true, protocolVersion: 'v1' });
      }
      try {
        const started = Date.now();
        const out = await handleGatekeeper(envelope);
        console.log('[gatekeeper]', envelope.task_id, out.decision, out.reason_code, Date.now() - started + 'ms');
        return sendSigned(res, 200, out);
      } catch (e) {
        console.error('[gatekeeper] handler error', e);
        return sendSigned(res, 500, { ok: false, error: 'handler error' });
      }
    });
    return;
  }

  return sendSigned(res, 404, { ok: false, error: 'not found' });
});

const { ensureCircuits } = require('./scripts/fetch-circuits');

ensureCircuits()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[gatekeeper] listening on ${HOST}:${PORT} (hmac ${HMAC_SECRET ? 'on' : 'OFF — set AGENT_GAMES_HMAC_SECRET before going live'})`);
      runSelfTest();
    });
  })
  .catch((e) => {
    console.error('[circuits] could not prepare circuit artifacts:', e.message);
    process.exit(1);
  });
