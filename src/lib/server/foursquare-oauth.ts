import type { SyncConfig } from './config';

const FOURSQUARE_AUTH_URL = 'https://foursquare.com/oauth2/authenticate';
const FOURSQUARE_TOKEN_URL = 'https://foursquare.com/oauth2/access_token';
const encoder = new TextEncoder();

interface FoursquareTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return bytesToBase64Url(signature);
}

export function requireFoursquareOAuthConfig(config: SyncConfig): { clientId: string; clientSecret: string } {
  if (!config.foursquareClientId || !config.foursquareClientSecret) {
    throw new Error('Set FOURSQUARE_CLIENT_ID and FOURSQUARE_CLIENT_SECRET before connecting Foursquare');
  }
  return {
    clientId: config.foursquareClientId,
    clientSecret: config.foursquareClientSecret
  };
}

export function foursquareRedirectUri(requestUrl: URL): string {
  const redirectUrl = new URL('/admin/checkins/callback', requestUrl);
  redirectUrl.search = '';
  redirectUrl.hash = '';
  return redirectUrl.toString();
}

export async function createFoursquareOAuthState(config: SyncConfig, redirectUri: string, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const payload = `${issuedAt}.${bytesToBase64Url(encoder.encode(redirectUri))}`;
  const signature = await hmacSha256Base64Url(config.ghostWebhookSecret, payload);
  return `${payload}.${signature}`;
}

export async function verifyFoursquareOAuthState(config: SyncConfig, state: string, redirectUri: string, now = Date.now()): Promise<boolean> {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [issuedAtValue, encodedRedirectUri, signature] = parts;
  const issuedAt = Number(issuedAtValue);
  if (!Number.isFinite(issuedAt)) return false;
  const maxAgeSeconds = 15 * 60;
  if (Math.abs(Math.floor(now / 1000) - issuedAt) > maxAgeSeconds) return false;
  if (encodedRedirectUri !== bytesToBase64Url(encoder.encode(redirectUri))) return false;
  const expected = await hmacSha256Base64Url(config.ghostWebhookSecret, `${issuedAtValue}.${encodedRedirectUri}`);
  return signature === expected;
}

export async function buildFoursquareAuthorizationUrl(config: SyncConfig, requestUrl: URL): Promise<string> {
  const { clientId } = requireFoursquareOAuthConfig(config);
  const redirectUri = foursquareRedirectUri(requestUrl);
  const url = new URL(FOURSQUARE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', await createFoursquareOAuthState(config, redirectUri));
  return url.toString();
}

export async function exchangeFoursquareCodeForAccessToken(config: SyncConfig, code: string, redirectUri: string): Promise<string> {
  const { clientId, clientSecret } = requireFoursquareOAuthConfig(config);
  const url = new URL(FOURSQUARE_TOKEN_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('grant_type', 'authorization_code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });

  let payload: FoursquareTokenResponse;
  try {
    payload = (await response.json()) as FoursquareTokenResponse;
  } catch {
    throw new Error(`Foursquare OAuth token exchange failed: ${response.status} ${response.statusText}`);
  }

  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || `${response.status} ${response.statusText}`;
    throw new Error(`Foursquare OAuth token exchange failed: ${detail}`);
  }

  return payload.access_token;
}

