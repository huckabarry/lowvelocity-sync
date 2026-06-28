import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { verifyConfiguredFoursquareAccess, verifyFoursquareAccessToken } from '$lib/server/checkins-native';

interface VerifyBody {
  accessToken?: string;
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export const POST: RequestHandler = async ({ request, platform }) => {
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
      return json({ requestId, ...(await verifyFoursquareAccessToken(accessToken)) });
    }

    const token = bearerToken(request);
    if (!token || !config.ghostStaffAccessToken || !timingSafeStringEqual(token, config.ghostStaffAccessToken)) {
      return json({ error: 'unauthorized', requestId }, { status: 401 });
    }

    return json({ requestId, ...(await verifyConfiguredFoursquareAccess(config)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: 'Foursquare verification failed', detail: message, requestId }, { status: 500 });
  }
};
