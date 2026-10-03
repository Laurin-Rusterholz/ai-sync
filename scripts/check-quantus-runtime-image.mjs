// Run in the actual built image with --network none, no credentials or mounts
// containing the repository. Imports must resolve from the image itself.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const load = path => import(pathToFileURL(resolve(path)));
for (const name of await readdir('runtime/quantus-v3/src')) {
  if (name.endsWith('.mjs') && name !== 'server.mjs') await load('runtime/quantus-v3/src/' + name);
}
for (const path of ['netlify/lib/gcal-shared.mjs', 'netlify/lib/firebase-admin.mjs',
  'netlify/lib/quantus-v3-idempotency.mjs']) await load(path);
for (const version of [3, 4]) {
  const prompts = await load(`netlify/lib/quantus-v${version}-prompts.mjs`);
  for (const slot of prompts.MAIN_PROMPT_SLOTS) {
    const bundle = await prompts[`loadQuantusV${version}Prompts`]({ slot, expectedVersion: prompts.PROMPT_VERSION });
    assert.equal(bundle.version, `${version}.0.0`);
    assert.ok(bundle.instruction.length > 2000);
  }
}
for (const [entry, route, expected] of [
  ['server.mjs','/v3/slot/start','runtime_not_configured'],
  ['commissioning-server.mjs','/v4/commissioning/respond','commissioning_not_configured'],
]) {
const server = spawn(process.execPath, ['runtime/quantus-v3/src/' + entry], {
  env: { PATH: process.env.PATH, PORT: '8080', NODE_ENV: 'production', NODE_OPTIONS: '--disable-proto=throw' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', b => { output += b; });
server.stderr.on('data', b => { output += b; });
const exited = new Promise(resolve => server.once('exit', resolve));
try {
  let response;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error('runtime exited before HTTP startup: ' + output);
    try { response = await fetch('http://127.0.0.1:8080' + route, { method: 'POST', signal: AbortSignal.timeout(500) }); break; }
    catch { await delay(100); }
  }
  assert.ok(response, 'runtime failed to listen: ' + output);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, expected);
  if (entry === 'server.mjs') assert.ok(Array.isArray(body.missing) && body.missing.length > 0);
  else assert.deepEqual(body, {error:expected});
  console.log(entry + ': image imports, reviewed prompts and fail-closed HTTP startup verified.');
} finally {
  server.kill('SIGTERM');
  await exited;
}
}
