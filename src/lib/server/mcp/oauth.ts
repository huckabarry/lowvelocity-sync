// Minimal OAuth 2.1 authorization server for the read-only MCP
// endpoint. It implements what Claude's custom connectors use:
//
// - RFC 9728 protected resource metadata
// - RFC 8414 authorization server metadata
// - RFC 7591 dynamic client registration (redirect URIs restricted to an allowlist)
// - Authorization code grant with mandatory PKCE (S256)
// - Refresh tokens
//
// Signed credentials are backed by atomic Durable Object replay/rotation state.
// Workers KV is not suitable for authentication concurrency control.
//
// The signing key is derived from MCP_TOKEN_SECRET *and* MCP_OWNER_PASSWORD,
// so rotating either secret immediately signs out every connected client.

import type { AuthOperation, AuthStore } from './auth-state.ts';
import { timingSafeStringEqual } from '../crypto.ts';

export const MCP_SCOPE = 'ghost:read';
export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback'
];

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const MIN_OWNER_PASSWORD_LENGTH = 16;

const TOKEN_PREFIX = 'lvm1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface McpAuthConfig {
  tokenSecret: string;
  ownerPassword: string;
  allowedRedirectUris: string[];
}

type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

interface ClientClaims {
  typ: 'client';
  redirect_uris: string[];
  name?: string;
  auth: ClientAuthMethod;
  iat: number;
}

interface CodeClaims {
  typ: 'code';
  cid: string;
  redirect_uri: string;
  challenge: string;
  scope: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface BearerClaims {
  typ: 'access' | 'refresh';
  family: string;
  cid: string;
  scope: string;
  aud: string;
  iss: string;
  jti: string;
  iat: number;
  exp: number;
}

type AnyClaims = ClientClaims | CodeClaims | BearerClaims;

export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;

  constructor(error: string, description: string, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = status;
  }

  toJSON() {
    return { error: this.error, error_description: this.message };
  }
}

interface McpEnv {
  MCP_ENABLED?: unknown;
  MCP_AUTH?: unknown;
  MCP_TOKEN_SECRET?: unknown;
  MCP_OWNER_PASSWORD?: unknown;
  MCP_ALLOWED_REDIRECT_URIS?: unknown;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Requires explicit enablement, the durable binding, and both valid secrets.
 * Production stays off until staged authentication verification is complete.
 */
export function getMcpAuthConfig(env: McpEnv | undefined): McpAuthConfig | null {
  if (env?.MCP_ENABLED !== 'true' || !env?.MCP_AUTH) return null;
  const tokenSecret = nonEmpty(env?.MCP_TOKEN_SECRET);
  const ownerPassword = nonEmpty(env?.MCP_OWNER_PASSWORD);
  if (!tokenSecret || tokenSecret.length < 32) return null;
  if (!ownerPassword || ownerPassword.length < MIN_OWNER_PASSWORD_LENGTH) return null;
  const configured = nonEmpty(env?.MCP_ALLOWED_REDIRECT_URIS);
  const allowedRedirectUris = configured
    ? configured.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_REDIRECT_URIS;
  return { tokenSecret, ownerPassword, allowedRedirectUris };
}

export function mcpUrls(origin: string) {
  const issuer = origin.replace(/\/$/, '');
  return {
    issuer,
    resource: `${issuer}/mcp`,
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    registrationEndpoint: `${issuer}/oauth/register`,
    protectedResourceMetadata: `${issuer}/.well-known/oauth-protected-resource/mcp`
  };
}

export function protectedResourceMetadata(origin: string) {
  const urls = mcpUrls(origin);
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Low Velocity (Ghost, read-only)'
  };
}

export function authorizationServerMetadata(origin: string) {
  const urls = mcpUrls(origin);
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorizationEndpoint,
    token_endpoint: urls.tokenEndpoint,
    registration_endpoint: urls.registrationEndpoint,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    authorization_response_iss_parameter_supported: true
  };
}

// ---------------------------------------------------------------------------
// Encoding and signing

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bufferSource(encoder.encode(value))));
}

async function signingKey(config: McpAuthConfig): Promise<CryptoKey> {
  const material = await sha256(`lowvelocity-mcp:v1\u0000${config.tokenSecret}\u0000${config.ownerPassword}`);
  return crypto.subtle.importKey('raw', bufferSource(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(config: McpAuthConfig, claims: AnyClaims): Promise<string> {
  const unsigned = `${TOKEN_PREFIX}.${bytesToBase64Url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await signingKey(config), bufferSource(encoder.encode(unsigned)))
  );
  return `${unsigned}.${bytesToBase64Url(signature)}`;
}

async function verify<T extends AnyClaims>(
  config: McpAuthConfig,
  token: string,
  typ: T['typ'],
  now: number
): Promise<T | null> {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const signature = base64UrlToBytes(parts[2]);
  const payload = base64UrlToBytes(parts[1]);
  if (!signature || !payload) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(config),
    bufferSource(signature),
    bufferSource(encoder.encode(`${parts[0]}.${parts[1]}`))
  );
  if (!valid) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const record = claims as Record<string, unknown>;
  if (record.typ !== typ) return null;
  const nowSeconds = Math.floor(now / 1000);
  if (typeof record.iat !== 'number' || record.iat > nowSeconds + 60) return null;
  if ('exp' in record && (typeof record.exp !== 'number' || record.exp <= nowSeconds)) return null;
  if (typ !== 'client' && typeof record.exp !== 'number') return null;
  return claims as T;
}

function randomId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

async function clientRef(clientId: string): Promise<string> {
  return bytesToBase64Url(await sha256(`client:${clientId}`)).slice(0, 32);
}

async function clientSecretFor(config: McpAuthConfig, clientId: string): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await signingKey(config), bufferSource(encoder.encode(`client-secret:${clientId}`)))
  );
  return bytesToBase64Url(signature);
}

// ---------------------------------------------------------------------------
// Dynamic client registration

const CLIENT_AUTH_METHODS: ClientAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

export async function registerClient(config: McpAuthConfig, body: unknown, now = Date.now()) {
  if (typeof body !== 'object' || body === null) {
    throw new OAuthError('invalid_client_metadata', 'Registration body must be a JSON object');
  }
  const metadata = body as Record<string, unknown>;

  const redirectUris = stringArray(metadata.redirect_uris);
  if (!redirectUris || redirectUris.length === 0 || redirectUris.length > 5) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list between 1 and 5 URIs');
  }
  const unknown = redirectUris.filter((uri) => !config.allowedRedirectUris.includes(uri));
  if (unknown.length) {
    throw new OAuthError('invalid_redirect_uri', `Redirect URI is not allowed: ${unknown[0]}`);
  }

  const grantTypes = metadata.grant_types === undefined ? ['authorization_code', 'refresh_token'] : stringArray(metadata.grant_types);
  if (!grantTypes || grantTypes.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token')) {
    throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
  }
  const responseTypes = metadata.response_types === undefined ? ['code'] : stringArray(metadata.response_types);
  if (!responseTypes || responseTypes.some((type) => type !== 'code')) {
    throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported');
  }

  const requestedAuth = metadata.token_endpoint_auth_method ?? 'client_secret_basic';
  if (typeof requestedAuth !== 'string' || !CLIENT_AUTH_METHODS.includes(requestedAuth as ClientAuthMethod)) {
    throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
  }
  const auth = requestedAuth as ClientAuthMethod;
  const name = typeof metadata.client_name === 'string' ? metadata.client_name.trim().slice(0, 100) : undefined;
  const issuedAt = Math.floor(now / 1000);

  const clientId = await sign(config, {
    typ: 'client',
    redirect_uris: redirectUris,
    ...(name ? { name } : {}),
    auth,
    iat: issuedAt
  });

  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    ...(auth === 'none' ? {} : { client_secret: await clientSecretFor(config, clientId), client_secret_expires_at: 0 }),
    ...(name ? { client_name: name } : {}),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: auth,
    scope: MCP_SCOPE
  };
}

export async function readClient(config: McpAuthConfig, clientId: string, now = Date.now()) {
  return verify<ClientClaims>(config, clientId, 'client', now);
}

async function authenticateClient(
  config: McpAuthConfig,
  clientId: string | undefined,
  clientSecret: string | undefined,
  now: number
): Promise<ClientClaims> {
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401);
  const client = await readClient(config, clientId, now);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
  if (client.auth !== 'none' || clientSecret !== undefined) {
    const expected = await clientSecretFor(config, clientId);
    if (!clientSecret || !timingSafeStringEqual(clientSecret, expected)) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
  }
  return client;
}

// ---------------------------------------------------------------------------
// Authorization endpoint

export interface AuthorizationRequest {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

export type AuthorizationValidation =
  | { ok: true; request: AuthorizationRequest }
  | { ok: false; redirectable: false; error: string; description: string }
  | { ok: false; redirectable: true; error: string; description: string; redirectUri: string; state?: string };

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

function sameResource(requested: string, resource: string): boolean {
  return requested.replace(/\/+$/, '') === resource.replace(/\/+$/, '');
}

export async function validateAuthorizationRequest(
  config: McpAuthConfig,
  params: URLSearchParams,
  origin: string,
  now = Date.now()
): Promise<AuthorizationValidation> {
  const clientId = params.get('client_id') ?? '';
  const client = clientId ? await readClient(config, clientId, now) : null;
  if (!client) {
    return { ok: false, redirectable: false, error: 'invalid_client', description: 'Unknown or missing client_id.' };
  }

  const requestedRedirect = params.get('redirect_uri');
  const redirectUri = requestedRedirect ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
  if (!redirectUri || !client.redirect_uris.includes(redirectUri) || !config.allowedRedirectUris.includes(redirectUri)) {
    return { ok: false, redirectable: false, error: 'invalid_request', description: 'The redirect_uri is not registered for this client.' };
  }

  const state = params.get('state') ?? undefined;
  const fail = (error: string, description: string): AuthorizationValidation => ({
    ok: false,
    redirectable: true,
    error,
    description,
    redirectUri,
    state
  });

  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');

  const codeChallenge = params.get('code_challenge') ?? '';
  if (!PKCE_VALUE.test(codeChallenge)) return fail('invalid_request', 'A PKCE code_challenge is required');
  if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');

  const requestedScopes = (params.get('scope') ?? '').split(/\s+/).filter(Boolean);
  if (requestedScopes.some((scope) => scope !== MCP_SCOPE)) return fail('invalid_scope', `Only the ${MCP_SCOPE} scope is available`);

  const { resource } = mcpUrls(origin);
  const requestedResource = params.get('resource');
  if (requestedResource && !sameResource(requestedResource, resource)) {
    return fail('invalid_target', 'This server only issues tokens for its own MCP endpoint');
  }

  return {
    ok: true,
    request: {
      clientId,
      clientName: client.name,
      redirectUri,
      state,
      codeChallenge,
      scope: MCP_SCOPE,
      resource
    }
  };
}

export function authorizationRedirect(
  redirectUri: string,
  issuer: string,
  values: Record<string, string | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set('iss', issuer);
  return url.toString();
}

export async function issueAuthorizationCode(
  config: McpAuthConfig,
  request: AuthorizationRequest,
  now = Date.now()
): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  return sign(config, {
    typ: 'code',
    cid: await clientRef(request.clientId),
    redirect_uri: request.redirectUri,
    challenge: request.codeChallenge,
    scope: request.scope,
    aud: request.resource,
    jti: randomId(),
    iat: issuedAt,
    exp: issuedAt + AUTHORIZATION_CODE_TTL_SECONDS
  });
}

export function ownerPasswordMatches(config: McpAuthConfig, candidate: string): boolean {
  return timingSafeStringEqual(candidate, config.ownerPassword);
}

async function authOperation(store: AuthStore | undefined, operation: AuthOperation): Promise<boolean> {
  if (!store) throw new OAuthError('temporarily_unavailable', 'Authentication storage is unavailable', 503);
  try {
    return await store.execute(operation);
  } catch {
    throw new OAuthError('temporarily_unavailable', 'Authentication storage is unavailable', 503);
  }
}

/** Reserve before checking a password, including successes, to bound concurrency. */
export function reserveLoginAttempt(store: AuthStore | undefined, now = Date.now()): Promise<boolean> {
  return authOperation(store, { kind: 'login', now });
}

// ---------------------------------------------------------------------------
// Token endpoint

export interface TokenRequest {
  grantType?: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  resource?: string;
}

/** Reads client credentials from the form body or an HTTP Basic header. */
export function parseTokenRequest(form: URLSearchParams, authorization: string | null): TokenRequest {
  const value = (name: string) => form.get(name) ?? undefined;
  let clientId = value('client_id');
  let clientSecret = value('client_secret');
  const basic = authorization?.match(/^Basic\s+(.+)$/i);
  if (basic) {
    try {
      const decoded = atob(basic[1].trim());
      const separator = decoded.indexOf(':');
      if (separator > -1) {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      }
    } catch {
      throw new OAuthError('invalid_client', 'Malformed Basic authorization header', 401);
    }
  }
  return {
    grantType: value('grant_type'),
    code: value('code'),
    redirectUri: value('redirect_uri'),
    codeVerifier: value('code_verifier'),
    refreshToken: value('refresh_token'),
    clientId,
    clientSecret,
    scope: value('scope'),
    resource: value('resource')
  };
}

async function issueTokens(config: McpAuthConfig, cid: string, scope: string, origin: string, now: number, family: string, refreshId: string, expires: number) {
  const { issuer, resource } = mcpUrls(origin);
  const issuedAt = Math.floor(now / 1000);
  const base = { family, cid, scope, aud: resource, iss: issuer, iat: issuedAt };
  const accessToken = await sign(config, { typ: 'access', ...base, jti: randomId(), exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS });
  const refreshToken = await sign(config, { typ: 'refresh', ...base, jti: refreshId, exp: expires });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope
  };
}

export async function exchangeToken(
  config: McpAuthConfig,
  request: TokenRequest,
  origin: string,
  store: AuthStore | undefined,
  now = Date.now()
) {
  const { resource } = mcpUrls(origin);
  if (request.resource && !sameResource(request.resource, resource)) {
    throw new OAuthError('invalid_target', 'This server only issues tokens for its own MCP endpoint');
  }

  if (request.grantType === 'authorization_code') {
    await authenticateClient(config, request.clientId, request.clientSecret, now);
    const code = request.code ? await verify<CodeClaims>(config, request.code, 'code', now) : null;
    if (!code) throw new OAuthError('invalid_grant', 'The authorization code is invalid or expired');
    if (code.cid !== (await clientRef(request.clientId!))) {
      throw new OAuthError('invalid_grant', 'The authorization code was issued to another client');
    }
    if (request.redirectUri !== code.redirect_uri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (!request.codeVerifier || !PKCE_VALUE.test(request.codeVerifier)) {
      throw new OAuthError('invalid_grant', 'A valid code_verifier is required');
    }
    const computed = bytesToBase64Url(await sha256(request.codeVerifier));
    if (!timingSafeStringEqual(computed, code.challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }
    if (!sameResource(code.aud, resource)) throw new OAuthError('invalid_grant', 'The authorization code is for another resource');
    const family = randomId();
    const refreshId = randomId();
    const expires = Math.floor(now / 1000) + REFRESH_TOKEN_TTL_SECONDS;
    const tokens = await issueTokens(config, code.cid, code.scope, origin, now, family, refreshId, expires);
    if (!await authOperation(store, { kind: 'create', now, code: code.jti, codeExpires: code.exp * 1000, family, current: refreshId, expires: expires * 1000 })) {
      throw new OAuthError('invalid_grant', 'The authorization code has already been used');
    }
    return tokens;
  }

  if (request.grantType === 'refresh_token') {
    await authenticateClient(config, request.clientId, request.clientSecret, now);
    const refresh = request.refreshToken ? await verify<BearerClaims>(config, request.refreshToken, 'refresh', now) : null;
    if (!refresh || !refresh.family || refresh.iss !== mcpUrls(origin).issuer || !sameResource(refresh.aud, resource)) {
      throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired');
    }
    if (refresh.cid !== (await clientRef(request.clientId!))) {
      throw new OAuthError('invalid_grant', 'The refresh token was issued to another client');
    }
    const requested = (request.scope ?? '').split(/\s+/).filter(Boolean);
    if (requested.some((scope) => scope !== refresh.scope)) {
      throw new OAuthError('invalid_scope', 'A refresh cannot widen the granted scope');
    }
    const next = randomId();
    const tokens = await issueTokens(config, refresh.cid, refresh.scope, origin, now, refresh.family, next, refresh.exp);
    if (!await authOperation(store, { kind: 'rotate', now, family: refresh.family, current: refresh.jti, next })) {
      throw new OAuthError('invalid_grant', 'Refresh token reused or revoked; authorize again');
    }
    return tokens;
  }

  throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token grants are supported');
}

// ---------------------------------------------------------------------------
// Resource server

export async function verifyAccessToken(
  config: McpAuthConfig,
  authorization: string | null,
  origin: string,
  store: AuthStore | undefined,
  now = Date.now()
): Promise<BearerClaims | null> {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const claims = await verify<BearerClaims>(config, match[1], 'access', now);
  if (!claims) return null;
  const { issuer, resource } = mcpUrls(origin);
  if (claims.iss !== issuer || !sameResource(claims.aud, resource)) return null;
  if (!claims.scope.split(/\s+/).includes(MCP_SCOPE)) return null;
  if (!claims.family || !await authOperation(store, { kind: 'active', now, family: claims.family })) return null;
  return claims;
}

export function wwwAuthenticate(origin: string, error?: 'invalid_token'): string {
  const parts = [
    'Bearer realm="lowvelocity-mcp"',
    `resource_metadata="${mcpUrls(origin).protectedResourceMetadata}"`,
    `scope="${MCP_SCOPE}"`
  ];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400'
};
