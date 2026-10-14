import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  authorizationServerMetadata,
  exchangeToken,
  getMcpAuthConfig,
  issueAuthorizationCode,
  loginAllowed,
  MAX_LOGIN_FAILURES_PER_HOUR,
  OAuthError,
  parseTokenRequest,
  protectedResourceMetadata,
  recordLoginFailure,
  registerClient,
  validateAuthorizationRequest,
  verifyAccessToken,
  type KeyValueStore,
  type McpAuthConfig
} from '../src/lib/server/mcp/oauth.ts';
import { lookupPath, nqlString } from '../src/lib/server/mcp/ghost-read.ts';
import { handleMcpPayload, TOOLS } from '../src/lib/server/mcp/server.ts';

const ORIGIN = 'https://sync.lowvelocity.org';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const GHOST = { ghostUrl: 'https://lowvelocity.org', ghostAdminApiKey: 'abc123:00112233445566778899aabbccddeeff' };

const config: McpAuthConfig = getMcpAuthConfig({
  MCP_TOKEN_SECRET: 'x'.repeat(48),
  MCP_OWNER_PASSWORD: 'correct horse battery staple'
})!;

class MemoryStore implements KeyValueStore {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

function pkcePair() {
  const verifier = 'verifier-' + 'a'.repeat(50);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    scope: 'ghost:read',
    resource: `${ORIGIN}/mcp`,
    ...extra
  });
}

async function authorizedCode(clientId: string, challenge: string) {
  const validation = await validateAuthorizationRequest(config, authorizeParams(clientId, challenge), ORIGIN);
  assert.equal(validation.ok, true);
  if (!validation.ok) throw new Error('unreachable');
  return issueAuthorizationCode(config, validation.request);
}

test('MCP auth stays disabled until both secrets are long enough', () => {
  assert.equal(getMcpAuthConfig(undefined), null);
  assert.equal(getMcpAuthConfig({ MCP_TOKEN_SECRET: 'x'.repeat(48) }), null);
  assert.equal(getMcpAuthConfig({ MCP_TOKEN_SECRET: 'short', MCP_OWNER_PASSWORD: 'a long enough passphrase' }), null);
  assert.equal(getMcpAuthConfig({ MCP_TOKEN_SECRET: 'x'.repeat(48), MCP_OWNER_PASSWORD: 'too short' }), null);
  assert.deepEqual(config.allowedRedirectUris, [CLAUDE_CALLBACK, 'https://claude.com/api/mcp/auth_callback']);
});

test('publishes discovery metadata that points at this Worker', () => {
  const resource = protectedResourceMetadata(ORIGIN);
  assert.equal(resource.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(resource.authorization_servers, [ORIGIN]);
  const server = authorizationServerMetadata(ORIGIN);
  assert.equal(server.issuer, ORIGIN);
  assert.equal(server.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
});

test('client registration only accepts allowlisted redirect URIs', async () => {
  await assert.rejects(
    registerClient(config, { redirect_uris: ['https://evil.example/callback'], token_endpoint_auth_method: 'none' }),
    (error: unknown) => error instanceof OAuthError && error.error === 'invalid_redirect_uri'
  );
  const client = await registerClient(config, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none', client_name: 'Claude' });
  assert.match(client.client_id, /^lvm1\./);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal('client_secret' in client, false);
});

test('authorization requests require PKCE S256 and the registered redirect', async () => {
  const { client_id } = await registerClient(config, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' });
  const { challenge } = pkcePair();

  const plain = await validateAuthorizationRequest(config, authorizeParams(client_id, challenge, { code_challenge_method: 'plain' }), ORIGIN);
  assert.equal(plain.ok, false);
  assert.equal(!plain.ok && plain.redirectable, true);

  const wrongRedirect = await validateAuthorizationRequest(
    config,
    authorizeParams(client_id, challenge, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }),
    ORIGIN
  );
  assert.equal(wrongRedirect.ok, false);
  assert.equal(!wrongRedirect.ok && wrongRedirect.redirectable, false);

  const forged = await validateAuthorizationRequest(config, authorizeParams(client_id + 'x', challenge), ORIGIN);
  assert.equal(forged.ok, false);

  const wrongResource = await validateAuthorizationRequest(
    config,
    authorizeParams(client_id, challenge, { resource: 'https://other.example/mcp' }),
    ORIGIN
  );
  assert.equal(!wrongResource.ok && wrongResource.error, 'invalid_target');

  const writeScope = await validateAuthorizationRequest(config, authorizeParams(client_id, challenge, { scope: 'ghost:write' }), ORIGIN);
  assert.equal(!writeScope.ok && writeScope.error, 'invalid_scope');
});

test('full authorization code flow issues tokens that the MCP endpoint accepts', async () => {
  const store = new MemoryStore();
  const { client_id } = await registerClient(config, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' });
  const { verifier, challenge } = pkcePair();
  const code = await authorizedCode(client_id, challenge);

  const tokens = await exchangeToken(
    config,
    { grantType: 'authorization_code', code, redirectUri: CLAUDE_CALLBACK, codeVerifier: verifier, clientId: client_id, resource: `${ORIGIN}/mcp` },
    ORIGIN,
    store
  );
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(tokens.scope, 'ghost:read');

  const claims = await verifyAccessToken(config, `Bearer ${tokens.access_token}`, ORIGIN);
  assert.ok(claims);
  assert.equal(await verifyAccessToken(config, `Bearer ${tokens.refresh_token}`, ORIGIN), null, 'refresh tokens are not access tokens');
  assert.equal(await verifyAccessToken(config, `Bearer ${tokens.access_token}`, 'https://lowvelocity-sync.example.workers.dev'), null);
  assert.equal(await verifyAccessToken(config, null, ORIGIN), null);

  // Codes are single-use.
  await assert.rejects(
    exchangeToken(config, { grantType: 'authorization_code', code, redirectUri: CLAUDE_CALLBACK, codeVerifier: verifier, clientId: client_id }, ORIGIN, store),
    (error: unknown) => error instanceof OAuthError && error.error === 'invalid_grant'
  );

  // Refresh tokens rotate and keep the same scope.
  const refreshed = await exchangeToken(config, { grantType: 'refresh_token', refreshToken: tokens.refresh_token, clientId: client_id }, ORIGIN, store);
  assert.ok(await verifyAccessToken(config, `Bearer ${refreshed.access_token}`, ORIGIN));
});

test('token exchange rejects a bad PKCE verifier, redirect, or client', async () => {
  const { client_id } = await registerClient(config, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' });
  const other = await registerClient(config, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none', client_name: 'Other' });
  const { verifier, challenge } = pkcePair();
  const code = await authorizedCode(client_id, challenge);
  const base = { grantType: 'authorization_code', code, redirectUri: CLAUDE_CALLBACK, codeVerifier: verifier, clientId: client_id };

  await assert.rejects(exchangeToken(config, { ...base, codeVerifier: 'b'.repeat(60) }, ORIGIN, undefined), /PKCE/);
  await assert.rejects(exchangeToken(config, { ...base, redirectUri: 'https://claude.com/api/mcp/auth_callback' }, ORIGIN, undefined), /redirect_uri/);
  await assert.rejects(exchangeToken(config, { ...base, clientId: other.client_id }, ORIGIN, undefined), /another client/);
  await assert.rejects(exchangeToken(config, { ...base, grantType: 'password' }, ORIGIN, undefined), /grant/);
});

test('confidential clients must authenticate with their issued secret', async () => {
  const client = await registerClient(config, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'client_secret_basic' });
  assert.ok(client.client_secret);
  const { verifier, challenge } = pkcePair();
  const code = await authorizedCode(client.client_id, challenge);

  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier });
  await assert.rejects(exchangeToken(config, parseTokenRequest(form, null), ORIGIN, undefined), /client_id is required/);

  const basic = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret!)}`)}`;
  const tokens = await exchangeToken(config, parseTokenRequest(form, basic), ORIGIN, undefined);
  assert.ok(tokens.access_token);

  const wrong = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:nope`)}`;
  await assert.rejects(exchangeToken(config, parseTokenRequest(form, wrong), ORIGIN, undefined), /Client authentication failed/);
});

test('changing the owner passphrase revokes every issued token', async () => {
  const { client_id } = await registerClient(config, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' });
  const { verifier, challenge } = pkcePair();
  const code = await authorizedCode(client_id, challenge);
  const tokens = await exchangeToken(
    config,
    { grantType: 'authorization_code', code, redirectUri: CLAUDE_CALLBACK, codeVerifier: verifier, clientId: client_id },
    ORIGIN,
    undefined
  );
  const rotated = { ...config, ownerPassword: 'a completely different passphrase' };
  assert.equal(await verifyAccessToken(rotated, `Bearer ${tokens.access_token}`, ORIGIN), null);
});

test('login attempts are throttled per hour', async () => {
  const store = new MemoryStore();
  const now = Date.UTC(2026, 9, 13, 5, 30);
  for (let index = 0; index < MAX_LOGIN_FAILURES_PER_HOUR; index += 1) {
    assert.equal(await loginAllowed(store, now), true);
    await recordLoginFailure(store, now);
  }
  assert.equal(await loginAllowed(store, now), false);
  assert.equal(await loginAllowed(store, now + 60 * 60 * 1000), true);
});

// ---------------------------------------------------------------------------
// MCP protocol and tools

function withGhostFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, method: init?.method ?? 'GET' });
    return handler(url, init);
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

test('MCP initialize, tools/list, and notifications', async () => {
  const init = (await handleMcpPayload(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } },
    { ghost: GHOST }
  )) as { result: { protocolVersion: string; capabilities: { tools: object } } };
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);

  const unknownVersion = (await handleMcpPayload(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    { ghost: GHOST }
  )) as { result: { protocolVersion: string } };
  assert.equal(unknownVersion.result.protocolVersion, '2025-11-25');

  assert.equal(await handleMcpPayload({ jsonrpc: '2.0', method: 'notifications/initialized' }, { ghost: GHOST }), null);

  const list = (await handleMcpPayload({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { ghost: GHOST })) as {
    result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
  };
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['search_posts', 'get_post', 'search_pages', 'get_page', 'list_tags']);
  assert.ok(list.result.tools.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(TOOLS.length, 5);

  const unknownTool = (await handleMcpPayload(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_post', arguments: {} } },
    { ghost: GHOST }
  )) as { error: { code: number } };
  assert.equal(unknownTool.error.code, -32602);

  const unknownMethod = (await handleMcpPayload({ jsonrpc: '2.0', id: 5, method: 'sampling/createMessage' }, { ghost: GHOST })) as {
    error: { code: number };
  };
  assert.equal(unknownMethod.error.code, -32601);
});

test('search_posts builds a read-only Ghost Admin query', async () => {
  const ghost = withGhostFetch(() =>
    Response.json({
      posts: [{
        id: 'a'.repeat(24),
        title: "Bryan's Walk",
        slug: 'bryans-walk',
        status: 'draft',
        url: 'https://lowvelocity.org/p/uuid/',
        published_at: null,
        updated_at: '2026-10-01T00:00:00.000Z',
        plaintext: 'A long walk along the river. '.repeat(20),
        tags: [{ name: 'walks' }]
      }],
      meta: { pagination: { page: 1, pages: 1, total: 1, next: null } }
    })
  );
  try {
    const response = (await handleMcpPayload(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_posts', arguments: { query: "Bryan's", tag: 'walks', status: 'draft', limit: 5 } } },
      { ghost: GHOST }
    )) as { result: { isError?: boolean; structuredContent: { results: Array<{ excerpt: string; tags: string[] }> } } };

    assert.equal(response.result.isError, undefined);
    assert.equal(ghost.requests.length, 1);
    const { url, method } = ghost.requests[0];
    assert.equal(method, 'GET');
    assert.equal(url.pathname, '/ghost/api/admin/posts/');
    assert.equal(url.searchParams.get('filter'), "title:~'Bryan\\'s'+tag:walks+status:draft");
    assert.equal(url.searchParams.get('formats'), 'plaintext');
    assert.equal(url.searchParams.get('limit'), '5');
    const [result] = response.result.structuredContent.results;
    assert.deepEqual(result.tags, ['walks']);
    assert.ok(result.excerpt.length <= 280);
  } finally {
    ghost.restore();
  }
});

test('get_post resolves a site URL to its slug and returns readable text', async () => {
  const ghost = withGhostFetch(() =>
    Response.json({
      posts: [{
        id: 'b'.repeat(24),
        title: 'On Slowness',
        slug: 'on-slowness',
        status: 'published',
        visibility: 'public',
        url: 'https://lowvelocity.org/on-slowness/',
        published_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-02T00:00:00.000Z',
        html: '<p>First paragraph.</p><p>Second paragraph.</p>',
        plaintext: 'First paragraph.\n\nSecond paragraph.',
        tags: [{ name: 'essays' }],
        authors: [{ name: 'Bryan' }]
      }]
    })
  );
  try {
    const response = (await handleMcpPayload(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_post', arguments: { url: 'https://www.lowvelocity.org/on-slowness/' } } },
      { ghost: GHOST }
    )) as { result: { content: Array<{ text: string }>; structuredContent: { word_count: number; truncated: boolean } } };

    assert.equal(ghost.requests[0].url.pathname, '/ghost/api/admin/posts/slug/on-slowness/');
    assert.equal(ghost.requests[0].method, 'GET');
    assert.match(response.result.content[0].text, /^# On Slowness/);
    assert.match(response.result.content[0].text, /Second paragraph\./);
    assert.equal(response.result.structuredContent.word_count, 4);
    assert.equal(response.result.structuredContent.truncated, false);
  } finally {
    ghost.restore();
  }
});

test('get_page reports a missing page and invalid lookups as tool errors', async () => {
  const ghost = withGhostFetch(() => Response.json({ errors: [{ message: 'Resource not found' }] }, { status: 404 }));
  try {
    const missing = (await handleMcpPayload(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'about' } } },
      { ghost: GHOST }
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /No page matched/);

    const both = (await handleMcpPayload(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'about', id: 'c'.repeat(24) } } },
      { ghost: GHOST }
    )) as { result: { isError: boolean } };
    assert.equal(both.result.isError, true);

    const extra = (await handleMcpPayload(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_pages', arguments: { html: '<p>x</p>' } } },
      { ghost: GHOST }
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(extra.result.isError, true);
    assert.match(extra.result.content[0].text, /Unknown argument/);
  } finally {
    ghost.restore();
  }
});

test('list_tags hides internal tags by default', async () => {
  const ghost = withGhostFetch(() =>
    Response.json({ tags: [{ name: 'updates', slug: 'updates', visibility: 'public', count: { posts: 42 } }], meta: { pagination: { page: 1, pages: 1, total: 1 } } })
  );
  try {
    const response = (await handleMcpPayload(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tags', arguments: { query: 'up' } } },
      { ghost: GHOST }
    )) as { result: { structuredContent: { tags: Array<{ posts: number }> } } };
    assert.equal(ghost.requests[0].url.searchParams.get('filter'), "visibility:public+name:~'up'");
    assert.equal(ghost.requests[0].url.searchParams.get('include'), 'count.posts');
    assert.equal(response.result.structuredContent.tags[0].posts, 42);
  } finally {
    ghost.restore();
  }
});

test('lookup paths and NQL quoting are safe', () => {
  assert.equal(nqlString("it's \\ odd"), "'it\\'s \\\\ odd'");
  assert.equal(lookupPath(GHOST, 'posts', { id: 'd'.repeat(24) }), `/ghost/api/admin/posts/${'d'.repeat(24)}/`);
  assert.equal(lookupPath(GHOST, 'pages', { slug: 'about' }), '/ghost/api/admin/pages/slug/about/');
  assert.throws(() => lookupPath(GHOST, 'posts', { id: '../settings' }), /24-character/);
  assert.throws(() => lookupPath(GHOST, 'posts', { url: 'https://example.com/post/' }), /lowvelocity\.org/);
  assert.throws(() => lookupPath(GHOST, 'posts', { slug: '../../settings' }), /invalid/);
});
