// Download the official Gatekeeper circuit artifacts if they are missing.
// Used on hosted deploys, where the (binary) artifacts are not in git.
// Source of truth: https://agentgames.zkverify.io/circuits/
const fs = require('fs');
const https = require('https');
const path = require('path');

const DIR = path.join(__dirname, '..', 'circuits');
const FILES = {
  'gatekeeper.wasm': 'https://agentgames.zkverify.io/circuits/gatekeeper.wasm',
  'gatekeeper_final.zkey': 'https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey',
};

// Verified 2026-11-17 (downloaded from the official URLs):
const EXPECTED = {
  'gatekeeper.wasm': {
    bytes: 1755820,
    sha256: 'be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f',
  },
  'gatekeeper_final.zkey': {
    bytes: 309750,
    sha256: 'adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d',
  },
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`download ${url} -> HTTP ${res.statusCode}`));
      }
      const tmp = dest + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureCircuits() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, url] of Object.entries(FILES)) {
    const dest = path.join(DIR, name);
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      console.log('[circuits] downloading', name);
      await download(url, dest);
    }
    const size = fs.statSync(dest).size;
    if (size !== EXPECTED[name].bytes) {
      console.warn(`[circuits] WARNING: ${name} is ${size} bytes, expected ${EXPECTED[name].bytes} — artifact may have changed`);
    }
  }
}

if (require.main === module) {
  ensureCircuits().then(() => console.log('[circuits] ready')).catch((e) => {
    console.error('[circuits] failed:', e.message);
    process.exit(1);
  });
}

module.exports = { ensureCircuits, FILES, EXPECTED };
