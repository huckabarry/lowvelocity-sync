import type { RequestHandler } from './$types';
import { exchangeToken, OAuthError, parseTokenRequest } from '$lib/server/mcp/oauth';
import { corsJson, mcpAuthConfig, mcpStore, notConfigured, preflight, publicOrigin } from '$lib/server/mcp/responses';

export const POST: RequestHandler = async ({ request, url, platform }) => {
  const config = mcpAuthConfig(platform);
  if (!config) return notConfigured();

  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
      throw new OAuthError('invalid_request', 'The token request must be form-encoded');
    }
    const form = new URLSearchParams(await request.text());
    const tokenRequest = parseTokenRequest(form, request.headers.get('authorization'));
    const tokens = await exchangeToken(config, tokenRequest, publicOrigin(platform, url), mcpStore(platform));
    return corsJson(tokens, { headers: { pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof OAuthError) {
      console.warn(JSON.stringify({ message: 'mcp oauth token rejected', error: error.error }));
      const headers: Record<string, string> = error.status === 401 ? { 'www-authenticate': 'Basic realm="lowvelocity-mcp"' } : {};
      return corsJson(error.toJSON(), { status: error.status, headers });
    }
    throw error;
  }
};

export const OPTIONS: RequestHandler = () => preflight();
