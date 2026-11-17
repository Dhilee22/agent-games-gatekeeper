// Durable state: the proof_tx seen-set + the per-task response cache.
//
// Why disk, not memory: the published reference implementations keep the
// seen-set in memory, so a restart forgets which proofs were already used
// and a replayed proof_tx could then be APPROVEd (-6) instead of caught.
// Persisting it closes that hole. The response cache also makes a platform
// retry of the same task_id return the byte-identical response.
//
// Format (JSON): { "seenProofTx": { "<proof_tx>": "<task_id>" },
//                   "responses":   { "<task_id>": <response object> } }
// Secrets are never written here.
const fs = require('fs');
const path = require('path');

function defaultPath() {
  return path.join(__dirname, '..', process.env.STATE_FILE || './state.json');
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      seenProofTx: new Map(Object.entries(raw.seenProofTx || {})),
      responses: new Map(Object.entries(raw.responses || {})),
    };
  } catch {
    return { seenProofTx: new Map(), responses: new Map() };
  }
}

function save(file, state) {
  const tmp = file + '.tmp';
  const data = JSON.stringify({
    seenProofTx: Object.fromEntries(state.seenProofTx),
    responses: Object.fromEntries(state.responses),
  });
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { defaultPath, load, save };
