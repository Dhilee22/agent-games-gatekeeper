// Proof Gatekeeper decision logic — the documented 7-trap checklist.
//
// The circuit enforces the same evaluation, so this logic must match it
// exactly: a decision that disagrees with the circuit fails witness
// generation and no proof can be produced at all.
//
// Check order — the FIRST failing trap wins and sets reason_code:
//   1. VK_SUBSTITUTION    proof_vk != registered_vk (case-insensitive)
//   2. PROOF_REUSED       proof_tx already seen under a DIFFERENT task_id.
//                         A retry of the SAME task_id is NOT reuse.
//   3. THRESHOLD_MISMATCH public_balance < minimum
//                         (balance EXACTLY equal to the minimum is VALID)
//   4. EXPIRED_CONDITION  current_block >= expiry_block
//                         (STRICT: current_block == expiry_block is EXPIRED)
//   5. RECIPIENT_MISMATCH recipient != condition_recipient (case-insensitive)
//   6. AMOUNT_OVERFLOW    amount > max_transfer
//                         (amount EXACTLY equal to the cap is VALID)
//   7. else VALID_CONDITION -> APPROVE
//
// Scoring asymmetry (official): correct +12, wrong APPROVE -6, wrong
// REJECT -3, timeout -2, missing/invalid proof -2, reliability bonus +0..+5.
// When in doubt, REJECT: a wrong approval costs twice a wrong rejection.
// Any error or uncertainty anywhere else in the server must also fail
// closed to REJECT, never approve by default.
//
// `seen` is a Map of lowercase proof_tx -> task_id, persisted to disk by
// lib/state.js so a restart does not forget which proofs were used.
// A task missing required fields is rejected with reason_code INVALID_TASK
// (a local guard, NOT one of the 7 official trap codes — TODO: confirm
// with the dashboard how malformed tasks are scored).
const REQUIRED_FIELDS = [
  'registered_vk', 'proof_vk', 'minimum', 'public_balance',
  'expiry_block', 'current_block', 'recipient', 'condition_recipient',
  'amount', 'max_transfer',
];

function decide(task, seen) {
  for (const f of REQUIRED_FIELDS) {
    if (task[f] === undefined || task[f] === null || task[f] === '') {
      return { decision: 'REJECT', reason_code: 'INVALID_TASK' };
    }
  }

  const registeredVk = String(task.registered_vk).toLowerCase();
  const proofVk = String(task.proof_vk).toLowerCase();
  if (proofVk !== registeredVk) {
    return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };
  }

  const proofTx = String(task.proof_tx || '').toLowerCase();
  const taskId = String(task.task_id || '');
  if (proofTx) {
    const prevTask = seen.get(proofTx);
    if (prevTask !== undefined && prevTask !== taskId) {
      return { decision: 'REJECT', reason_code: 'PROOF_REUSED' };
    }
    if (prevTask === undefined) seen.set(proofTx, taskId);
  }

  if (BigInt(task.public_balance) < BigInt(task.minimum)) {
    return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
  }
  if (BigInt(task.current_block) >= BigInt(task.expiry_block)) {
    return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
  }
  if (String(task.recipient).toLowerCase() !== String(task.condition_recipient).toLowerCase()) {
    return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
  }
  if (BigInt(task.amount) > BigInt(task.max_transfer)) {
    return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };
  }
  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' };
}

module.exports = { decide, REQUIRED_FIELDS };
