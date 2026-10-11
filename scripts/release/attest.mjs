// Sign the final helper before hashing it. Only public signer identifiers reach build constants.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareHelper(binary, { platform = process.platform, env = process.env, run = execFileSync, warn = message => console.warn(`::warning::${message}`) } = {}) {
  const pins = {};
  if (platform !== 'win32') chmodSync(binary, 0o755);
  if (platform === 'darwin') {
    const team = env.PLUR1BUS_ATTEST_TEAM_ID, identity = env.PLUR1BUS_ATTEST_SIGN_IDENTITY;
    if (team && identity) {
      if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('Invalid attestation team ID');
      run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', binary], { stdio: 'inherit' });
      run('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`, binary], { stdio: 'inherit' });
      pins.PLUR1BUS_ATTEST_TEAM_ID = team;
    } else {
      // lipo invalidates the thin binaries' ad-hoc signatures; Apple Silicon still needs a valid one.
      run('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' });
      warn('Attestation signing identity/team ID absent; pinning by hash and permissions only.');
    }
  } else if (platform === 'win32') {
    const thumb = env.PLUR1BUS_ATTEST_WIN_THUMBPRINT;
    if (thumb) {
      if (!/^[0-9A-Fa-f]{40}$/.test(thumb)) throw new Error('Invalid attestation signer thumbprint');
      const script = "$ErrorActionPreference='Stop'; $cert=Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\'+$env:ATTEST_SIGN_THUMBPRINT); $s=Set-AuthenticodeSignature -LiteralPath $env:ATTEST_SIGN_PATH -Certificate $cert -HashAlgorithm SHA256; if ($s.Status -ne 'Valid') { throw 'Helper signing failed' }; $v=Get-AuthenticodeSignature -LiteralPath $env:ATTEST_SIGN_PATH; if ($v.Status -ne 'Valid' -or $v.SignerCertificate.Thumbprint -ne $env:ATTEST_SIGN_THUMBPRINT) { throw 'Helper signature verification failed' }";
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit', env: { ...process.env, ATTEST_SIGN_PATH: resolve(binary), ATTEST_SIGN_THUMBPRINT: thumb } });
      pins.PLUR1BUS_ATTEST_WIN_THUMBPRINT = thumb.toUpperCase();
    } else warn('Attestation signer thumbprint absent; pinning by hash and permissions only.');
  }
  return { PLUR1BUS_ATTEST_SHA256: createHash('sha256').update(readFileSync(binary)).digest('hex'), ...pins };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--load') {
    const dir = process.argv[3];
    const pins = JSON.parse(readFileSync(join(dir, 'pins.json'), 'utf8'));
    const binary = join(dir, process.platform === 'win32' ? 'plur1bus-attest.exe' : 'plur1bus-attest');
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
    if (digest !== pins.PLUR1BUS_ATTEST_SHA256) throw new Error('Downloaded helper does not match its build pin');
    for (const [key, value] of Object.entries(pins)) {
      const patterns = { PLUR1BUS_ATTEST_SHA256: /^[a-f0-9]{64}$/, PLUR1BUS_ATTEST_TEAM_ID: /^[A-Z0-9]{10}$/, PLUR1BUS_ATTEST_WIN_THUMBPRINT: /^[A-F0-9]{40}$/ };
      if (!patterns[key]?.test(value)) throw new Error('Invalid helper build pin');
      appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
    }
  } else {
    const [binary, out] = process.argv.slice(2);
    if (!binary || !out) throw new Error('usage: attest.mjs BINARY PINS.json | --load DIRECTORY');
    writeFileSync(out, `${JSON.stringify(prepareHelper(binary), null, 2)}\n`);
  }
}
