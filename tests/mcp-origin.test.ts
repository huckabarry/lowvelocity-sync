import assert from 'node:assert/strict';
import test from 'node:test';
import { oauthTokenRequest } from '../src/lib/server/mcp/token-origin.ts';

test('only originless backend token forms receive the CSRF exception', async () => {
  const request = new Request('https://sync.lowvelocity.org/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'ignored=1', authorization: 'Basic abc', 'sec-fetch-mode': 'cors' }, body: 'grant_type=authorization_code'
  });
  const translated = oauthTokenRequest(request);
  assert.equal(translated.headers.get('origin'), 'https://sync.lowvelocity.org');
  assert.equal(translated.headers.get('cookie'), null);
  assert.equal(translated.headers.get('authorization'), 'Basic abc');
  assert.equal(await translated.text(), 'grant_type=authorization_code');
  for (const path of ['/oauth/authorize', '/admin/import/bluesky', '/webhooks/ghost', '/oauth/token/', '/mcp']) {
    const other = new Request(`https://sync.lowvelocity.org${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(oauthTokenRequest(other), other);
  }
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-dest': 'document' }, { 'content-type': 'text/plain' }] as Record<string, string>[]) {
    const other = new Request('https://sync.lowvelocity.org/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
    assert.equal(oauthTokenRequest(other), other);
  }
});
