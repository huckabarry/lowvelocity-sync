import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const source = await readFile('.svelte-kit/cloudflare/_worker.js', 'utf8');
assert.match(source, /async scheduled\(controller, env2, ctx\)/);
for (const importer of ['Bluesky', 'Checkins', 'CrucialTracks', 'Popfeed']) {
  assert.ok(source.includes(`runScheduled${importer}Import(env2, ctx, controller)`));
}
const built = await build({ entryPoints: ['.svelte-kit/cloudflare/_worker.js'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:*', 'node:*'] });
const common = {
  modules: [{ type: 'ESModule', path: 'worker.mjs', contents: built.outputFiles[0].text }], compatibilityDate: '2026-06-20', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { MCP_AUTH: { className: 'McpAuthState', useSQLite: true } },
  serviceBindings: { ASSETS: () => new Response('Not found', { status: 404 }) }
};
const origin = 'https://sync.lowvelocity.org';
const password = 'integration-test-password-not-a-secret';
const bindings = {
  MCP_ENABLED: 'true', MCP_TOKEN_SECRET: 'integration-only-secret-'.repeat(3), MCP_OWNER_PASSWORD: password,
  MCP_PUBLIC_ORIGIN: origin, GHOST_URL: 'https://ghost.invalid',
  GHOST_ADMIN_API_KEY: 'abc:00112233445566778899aabbccddeeff', GHOST_STAFF_ACCESS_TOKEN: 'test-staff', GHOST_WEBHOOK_SECRET: 'test-webhook',
  ATPROTO_SERVICE: 'https://pds.invalid', ATPROTO_IDENTIFIER: 'test', ATPROTO_DID: 'did:plc:test', ATPROTO_APP_PASSWORD: 'test', PUBLICATION_URI: 'at://did:plc:test/site.standard.publication/abc'
};
const enabled = new Miniflare({ ...common, bindings });
const disabled = new Miniflare({ ...common, bindings: { ...bindings, MCP_ENABLED: 'false' } });
const missing = new Miniflare({ ...common, durableObjects: {}, bindings });
const call = (runtime, path, init) => runtime.dispatchFetch(origin + path, { redirect: 'manual', ...init });
const form = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
try {
  for (const runtime of [disabled, missing]) {
    for (const path of ['/mcp', '/oauth/token', '/oauth/register']) assert.equal((await call(runtime, path, { method: 'POST' })).status, 404, path);
    for (const path of ['/oauth/authorize', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) assert.equal((await call(runtime, path)).status, 404, path);
    assert.equal((await (await call(runtime, '/health')).json()).configured.mcp, false);
  }
  assert.equal((await call(enabled, '/')).status, 200);
  assert.equal((await call(enabled, '/.well-known/site.standard.publication')).status, 200);
  for (const path of ['/admin/import/bluesky', '/admin/import/checkins', '/admin/import/crucial-tracks', '/admin/import/popfeed', '/admin/pika']) {
    assert.equal((await call(enabled, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, path);
  }
  assert.equal((await call(enabled, '/webhooks/ghost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const callback = 'https://claude.ai/api/mcp/auth_callback';
  const registration = await call(enabled, '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = 'v'.repeat(64);
  const authorization = { client_id: client.client_id, redirect_uri: callback, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'test-state', decision: 'allow', password };
  assert.equal((await call(enabled, '/oauth/authorize?' + new URLSearchParams(authorization))).status, 200);
  for (const path of ['/oauth/authorize', '/oauth/token', '/admin/import/bluesky', '/webhooks/ghost']) {
    assert.equal((await call(enabled, path, form(authorization, { origin: 'https://evil.example' }))).status, 403, path);
    assert.equal((await call(enabled, path, form(authorization, { origin: 'null' }))).status, 403, path);
  }
  assert.equal((await call(enabled, '/oauth/authorize', form(authorization))).status, 403);
  assert.equal((await call(enabled, '/oauth/token', form({}, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  const consent = await call(enabled, '/oauth/authorize', form(authorization, { origin }));
  assert.equal(consent.status, 302);
  const redirect = new URL(consent.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), 'test-state');
  const exchange = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, code_verifier: verifier, code: redirect.searchParams.get('code') };
  const response = await call(enabled, '/oauth/token', form(exchange));
  assert.equal(response.status, 200, await response.clone().text());
  const first = await response.json();
  assert.equal((await call(enabled, '/oauth/token', form(exchange))).status, 400);
  const rpc = token => call(enabled, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await rpc(first.access_token)).status, 200);
  assert.equal((await call(enabled, '/admin/import/bluesky', { method: 'POST', headers: { authorization: `Bearer ${first.access_token}`, 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const refresh = token => call(enabled, '/oauth/token', form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token }));
  const secondResponse = await refresh(first.refresh_token);
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal((await rpc(second.access_token)).status, 200);
  assert.equal((await refresh(first.refresh_token)).status, 400);
  assert.equal((await refresh(second.refresh_token)).status, 400);
  assert.equal((await rpc(first.access_token)).status, 401);
  assert.equal((await rpc(second.access_token)).status, 401);
  const attempts = await Promise.all(Array.from({ length: 30 }, () => call(enabled, '/oauth/authorize', form({ ...authorization, password: 'wrong' }, { origin }))));
  assert.equal(attempts.filter(response => response.status === 401).length, 9); // one successful reservation above
  assert.equal(attempts.filter(response => response.status === 429).length, 21);
  assert.equal((await call(enabled, '/oauth/authorize', form(authorization, { origin }))).status, 429);
  console.log('PASS: built Worker OAuth flow, replay revocation, concurrent login, CSRF, disabled/missing-binding behavior, admin/webhook isolation, and scheduled-handler preservation');
} finally {
  await Promise.all([enabled.dispose(), disabled.dispose(), missing.dispose()]);
}
