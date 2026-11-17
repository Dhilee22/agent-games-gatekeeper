// HMAC-SHA256 signing for Agent Games envelopes.
//
// Protocol (from the published verified implementations + the tournament
// build guide):
// - The platform signs every inbound envelope with the per-agent secret
//   issued by the dashboard ("Rotate Secret") and sends the digest in the
//   `x-agent-games-signature` header.
// - Verification runs over the RAW request bytes, BEFORE JSON parsing:
//   re-serialising parsed JSON would change the bytes and break it.
// - Every response (including errors) is signed the same way, so the
//   platform can verify the decision really came from this agent.
// - Default encoding is lowercase hex; the `sha256=<hex>` form is the
//   fallback if the platform rejects the preflight (AGENT_GAMES_HMAC_FORMAT).
const crypto = require('crypto');

function signatureFor(secret, rawBody, format) {
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return format === 'sha256=' ? 'sha256=' + hex : hex;
}

function verifySignature(secret, rawBody, headerValue, format) {
  if (!secret || !headerValue) return false;
  const expected = Buffer.from(signatureFor(secret, rawBody, format));
  const actual = Buffer.from(String(headerValue));
  if (expected.length !== actual.length) return false;
  try {
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = { signatureFor, verifySignature };
