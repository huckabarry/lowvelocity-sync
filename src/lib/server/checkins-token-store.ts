import type { SyncConfig } from './config.ts';

const FOURSQUARE_TOKEN_KEY = 'foursquare:access-token';

function normalizeToken(value: string | null | undefined): string | undefined {
  const token = String(value || '').trim();
  return token || undefined;
}

export function checkinsTokenStore(platform: App.Platform | undefined): KVNamespace | undefined {
  return platform?.env?.CHECKINS_KV;
}

export function hasCheckinsTokenStore(platform: App.Platform | undefined): boolean {
  return Boolean(checkinsTokenStore(platform));
}

export async function readStoredFoursquareAccessToken(platform: App.Platform | undefined): Promise<string | undefined> {
  const store = checkinsTokenStore(platform);
  if (!store) return undefined;
  return normalizeToken(await store.get(FOURSQUARE_TOKEN_KEY));
}

export async function writeStoredFoursquareAccessToken(platform: App.Platform | undefined, accessToken: string): Promise<boolean> {
  const store = checkinsTokenStore(platform);
  const token = normalizeToken(accessToken);
  if (!store || !token) return false;
  await store.put(FOURSQUARE_TOKEN_KEY, token);
  return true;
}

export async function resolveFoursquareAccessToken(
  config: SyncConfig,
  platform: App.Platform | undefined
): Promise<{ accessToken: string | undefined; source: 'kv' | 'secret' | 'missing' }> {
  const stored = await readStoredFoursquareAccessToken(platform);
  if (stored) return { accessToken: stored, source: 'kv' };
  if (config.foursquareAccessToken) return { accessToken: config.foursquareAccessToken, source: 'secret' };
  return { accessToken: undefined, source: 'missing' };
}
