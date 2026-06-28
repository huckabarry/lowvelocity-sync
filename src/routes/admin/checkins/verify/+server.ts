import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { verifyConfiguredFoursquareAccess, verifyFoursquareAccessToken } from '$lib/server/checkins-native';
import { foursquareRedirectUri, verifyFoursquareOAuthState } from '$lib/server/foursquare-oauth';
import { resolveFoursquareAccessToken, writeStoredFoursquareAccessToken } from '$lib/server/checkins-token-store';

interface VerifyBody {
  accessToken?: string;
  state?: string;
  store?: boolean;
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export const POST: RequestHandler = async ({ request, platform, url }) => {
  const requestId = crypto.randomUUID();

  try {
    const config = getSyncConfig(platform);
    let body: VerifyBody = {};
    try {
      body = (await request.json()) as VerifyBody;
    } catch {
      body = {};
    }

    const accessToken = body.accessToken?.trim();
    if (accessToken) {
      const verification = await verifyFoursquareAccessToken(accessToken);
      let stored = false;
      if (body.store) {
        const state = body.state?.trim() || '';
        const redirectUri = foursquareRedirectUri(url);
        if (!state || !(await verifyFoursquareOAuthState(config, state, redirectUri))) {
          return json({ ok: false, error: 'invalid or expired Foursquare OAuth state', requestId }, { status: 400 });
        }
        stored = await writeStoredFoursquareAccessToken(platform, accessToken);
      }
      return json({ requestId, stored, tokenSource: stored ? 'kv' : 'provided', ...verification });
    }

    const token = bearerToken(request);
    if (!token || !config.ghostStaffAccessToken || !timingSafeStringEqual(token, config.ghostStaffAccessToken)) {
      return json({ error: 'unauthorized', requestId }, { status: 401 });
    }

    const tokenResolution = await resolveFoursquareAccessToken(config, platform);
    const verification = tokenResolution.accessToken
      ? await verifyFoursquareAccessToken(tokenResolution.accessToken)
      : await verifyConfiguredFoursquareAccess(config);
    return json({ requestId, tokenSource: tokenResolution.source, ...verification });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: 'Foursquare verification failed', detail: message, requestId }, { status: 500 });
  }
};
