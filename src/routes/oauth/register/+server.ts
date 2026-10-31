import type { RequestHandler } from './$types';
import { OAuthError, registerClient } from '$lib/server/mcp/oauth';
import { corsJson, mcpAuthConfig, notConfigured, preflight } from '$lib/server/mcp/responses';

// RFC 7591 dynamic client registration. Only allowlisted redirect URIs
// (Claude's connector callbacks by default) can register.
export const POST: RequestHandler = async ({ request, platform }) => {
  const config = mcpAuthConfig(platform);
  if (!config) return notConfigured();
  if (Number(request.headers.get('content-length') ?? 0) > 16 * 1024) {
    return corsJson({ error: 'invalid_client_metadata', error_description: 'Registration body is too large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return corsJson({ error: 'invalid_client_metadata', error_description: 'Registration body must be JSON' }, { status: 400 });
  }

  try {
    const registration = await registerClient(config, body);
    console.log(JSON.stringify({ message: 'mcp oauth client registered', clientName: registration.client_name ?? null }));
    return corsJson(registration, { status: 201 });
  } catch (error) {
    if (error instanceof OAuthError) return corsJson(error.toJSON(), { status: error.status });
    throw error;
  }
};

export const OPTIONS: RequestHandler = () => preflight();
