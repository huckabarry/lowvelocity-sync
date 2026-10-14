import type { RequestHandler } from './$types';
import { ghostReadConfig } from '$lib/server/mcp/ghost-read';
import { CORS_HEADERS, verifyAccessToken, wwwAuthenticate } from '$lib/server/mcp/oauth';
import { corsJson, mcpAuthConfig, notConfigured, preflight, publicOrigin } from '$lib/server/mcp/responses';
import { handleMcpPayload, parseErrorResponse, SUPPORTED_PROTOCOL_VERSIONS } from '$lib/server/mcp/server';

const MAX_BODY_BYTES = 1024 * 1024;

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { ...CORS_HEADERS, allow: 'POST, OPTIONS' } });
}

// Streamable HTTP transport, stateless: every POST is answered with a single
// JSON response, so there is no session id and no server-sent event stream.
export const POST: RequestHandler = async ({ request, url, platform }) => {
  const config = mcpAuthConfig(platform);
  if (!config) return notConfigured();

  const authorization = request.headers.get('authorization');
  const claims = await verifyAccessToken(config, authorization, publicOrigin(platform, url));
  if (!claims) {
    return corsJson(
      { error: authorization ? 'invalid_token' : 'unauthorized', error_description: 'A valid access token is required' },
      { status: 401, headers: { 'www-authenticate': wwwAuthenticate(publicOrigin(platform, url), authorization ? 'invalid_token' : undefined) } }
    );
  }

  const protocolVersion = request.headers.get('mcp-protocol-version');
  if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return corsJson({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${protocolVersion}` } }, { status: 400 });
  }

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return corsJson({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body is too large' } }, { status: 413 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return corsJson({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body is too large' } }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return corsJson(parseErrorResponse(), { status: 400 });
  }

  const response = await handleMcpPayload(payload, { ghost: ghostReadConfig(platform?.env) });
  if (response === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return corsJson(response);
};

export const GET: RequestHandler = () => methodNotAllowed();
export const DELETE: RequestHandler = () => methodNotAllowed();
export const OPTIONS: RequestHandler = () => preflight();
