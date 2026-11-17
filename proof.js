// Groth16 proof generation for the official Gatekeeper circuit.
//
// Circuit facts (verified against the published artifacts + the tournament
// build guide):
// - Curve BN254 (bn128), Circom 2.x. Artifacts: gatekeeper.wasm (1.7 MB)
//   + gatekeeper_final.zkey, downloaded from agentgames.zkverify.io/circuits.
//   No verification-key JSON is published; the VK is exported from the
//   zkey with snarkjs.zKey.exportVerificationKey.
// - 13 circuit inputs: registeredVkHash, proofVkHash, minimum,
//   publicBalance, expiryBlock, currentBlock, recipient,
//   conditionRecipient, amount, maxTransfer, decision (1 = APPROVE,
//   0 = REJECT), taskId, salt (private, fresh random 32 bytes per proof).
// - 13 public signals: a salt-dependent binding hash first, then the 12
//   public task fields in the same order as the inputs (minus salt).
// - The circuit enforces the decision: a decision that disagrees with the
//   circuit's own evaluation fails witness generation, so no proof can be
//   produced for a wrong decision. The JS checklist in gatekeeper.js must
//   therefore mirror the circuit bit-exactly.
// - taskId mapping: the envelope task_id is a string like "gk_24_9d1" and
//   the circuit needs a field element. Default mode "keccak":
//   keccak256(utf8(task_id)) mod FIELD_PRIME. Alternatives via
//   GATEKEEPER_TASK_ID_MODE: "numeric" (digits only), "hex" (hex chars).
//   TODO: confirm against a practice task after registration.
const crypto = require('crypto');
const path = require('path');
const snarkjs = require('snarkjs');
const { toField, keccak256ModP } = require('./field');

const WASM = path.join(__dirname, '..', 'circuits', 'gatekeeper.wasm');
const ZKEY = path.join(__dirname, '..', 'circuits', 'gatekeeper_final.zkey');

let vkPromise = null;
function getVerificationKey() {
  if (!vkPromise) vkPromise = snarkjs.zKey.exportVerificationKey(ZKEY);
  return vkPromise;
}

function taskIdToField(taskId, mode) {
  const id = String(taskId || '');
  if (mode === 'numeric') {
    const digits = id.replace(/\D/g, '');
    return digits ? toField(BigInt(digits)) : 0n;
  }
  if (mode === 'hex') {
    const hex = id.replace(/[^0-9a-fA-F]/g, '');
    return hex ? toField(BigInt('0x' + hex)) : 0n;
  }
  return keccak256ModP([Buffer.from(id, 'utf8')]);
}

function buildCircuitInput(task, decision, taskIdMode) {
  return {
    registeredVkHash: String(task.registered_vk),
    proofVkHash: String(task.proof_vk),
    minimum: String(task.minimum),
    publicBalance: String(task.public_balance),
    expiryBlock: String(task.expiry_block),
    currentBlock: String(task.current_block),
    recipient: String(task.recipient),
    conditionRecipient: String(task.condition_recipient),
    amount: String(task.amount),
    maxTransfer: String(task.max_transfer),
    decision: decision === 'APPROVE' ? '1' : '0',
    taskId: taskIdToField(task.task_id, taskIdMode).toString(),
    salt: '0x' + crypto.randomBytes(32).toString('hex'),
  };
}

async function proveTask(task, decision, taskIdMode) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    buildCircuitInput(task, decision, taskIdMode),
    WASM,
    ZKEY
  );
  return { proof, publicSignals };
}

async function verifyLocally(publicSignals, proof) {
  const vk = await getVerificationKey();
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

module.exports = { taskIdToField, buildCircuitInput, proveTask, verifyLocally, getVerificationKey };
