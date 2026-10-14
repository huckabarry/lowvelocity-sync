// A small, stateless MCP server (Streamable HTTP transport, JSON responses
// only). It exposes read-only Ghost tools; there are no write tools here.

import { UpstreamError } from '../http.ts';
import {
  getContent,
  listTags,
  LookupError,
  searchContent,
  type ContentDetail,
  type GhostContentType,
  type GhostOrder,
  type GhostReadConfig,
  type GhostStatusFilter
} from './ghost-read.ts';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_INFO = {
  name: 'lowvelocity-ghost',
  title: 'Low Velocity (Ghost)',
  version: '0.1.0'
};

const INSTRUCTIONS =
  'Read-only access to the Low Velocity Ghost site. Use search_posts or search_pages to find content ' +
  '(title matching, tag, and status filters), then get_post or get_page to read the full text. ' +
  'list_tags shows the tags available for filtering. Internal tags start with #. Nothing here can publish or edit.';

export interface McpContext {
  ghost: GhostReadConfig | null;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const STATUS_SCHEMA = {
  type: 'string',
  enum: ['all', 'published', 'draft', 'scheduled'],
  default: 'all',
  description: 'Limit results to one status. Defaults to all statuses, including drafts.'
};

function searchSchema(noun: string) {
  return {
    type: 'object',
    properties: {
      query: { type: 'string', description: `Text the ${noun} title should contain (case-insensitive). Omit to list recent ${noun}s.` },
      tag: { type: 'string', description: 'Tag name or slug to filter by, for example "updates" or "#bluesky".' },
      status: STATUS_SCHEMA,
      order: {
        type: 'string',
        enum: ['newest', 'oldest', 'recently_updated'],
        default: 'newest',
        description: 'Sort by publish date (newest or oldest) or by last update.'
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
      page: { type: 'integer', minimum: 1, default: 1 }
    },
    additionalProperties: false
  };
}

function getSchema(noun: string) {
  return {
    type: 'object',
    properties: {
      id: { type: 'string', description: `The 24-character Ghost ${noun} id.` },
      slug: { type: 'string', description: `The ${noun} slug.` },
      url: { type: 'string', description: `A public URL of the ${noun} on the site.` },
      format: {
        type: 'string',
        enum: ['text', 'html'],
        default: 'text',
        description: 'Return the body as plain text (default) or as Ghost-rendered HTML.'
      },
      max_characters: {
        type: 'integer',
        minimum: 1000,
        maximum: 200000,
        default: 50000,
        description: 'Truncate the body after this many characters.'
      }
    },
    additionalProperties: false
  };
}

export const TOOLS = [
  {
    name: 'search_posts',
    title: 'Search posts',
    description: 'Find Ghost posts by title text, tag, and status. Returns titles, URLs, dates, tags, and short excerpts.',
    inputSchema: searchSchema('post'),
    annotations: { title: 'Search posts', ...READ_ONLY_ANNOTATIONS }
  },
  {
    name: 'get_post',
    title: 'Read a post',
    description: 'Read one Ghost post in full. Identify it with exactly one of id, slug, or url.',
    inputSchema: getSchema('post'),
    annotations: { title: 'Read a post', ...READ_ONLY_ANNOTATIONS }
  },
  {
    name: 'search_pages',
    title: 'Search pages',
    description: 'Find Ghost pages (standalone pages such as About) by title text, tag, and status.',
    inputSchema: searchSchema('page'),
    annotations: { title: 'Search pages', ...READ_ONLY_ANNOTATIONS }
  },
  {
    name: 'get_page',
    title: 'Read a page',
    description: 'Read one Ghost page in full. Identify it with exactly one of id, slug, or url.',
    inputSchema: getSchema('page'),
    annotations: { title: 'Read a page', ...READ_ONLY_ANNOTATIONS }
  },
  {
    name: 'list_tags',
    title: 'List tags',
    description: 'List the site\'s tags with post counts, optionally filtered by name. Public tags only unless include_internal is true.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text the tag name should contain.' },
        include_internal: { type: 'boolean', default: false, description: 'Also include internal (#) tags.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        page: { type: 'integer', minimum: 1, default: 1 }
      },
      additionalProperties: false
    },
    annotations: { title: 'List tags', ...READ_ONLY_ANNOTATIONS }
  }
];

// ---------------------------------------------------------------------------
// Argument validation

class InvalidArguments extends Error {}

type Args = Record<string, unknown>;

function allowOnly(args: Args, allowed: string[]) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new InvalidArguments(`Unknown argument: ${unknown[0]}`);
}

function optionalString(args: Args, key: string, max = 500): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InvalidArguments(`${key} must be a string`);
  if (value.length > max) throw new InvalidArguments(`${key} is too long`);
  return value;
}

function optionalInteger(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidArguments(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function optionalEnum<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new InvalidArguments(`${key} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new InvalidArguments(`${key} must be true or false`);
  return value;
}

// ---------------------------------------------------------------------------
// Tool results

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function jsonResult(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function detailResult(detail: ContentDetail): ToolResult {
  const header = [
    `# ${detail.title}`,
    '',
    `- id: ${detail.id}`,
    `- url: ${detail.url}`,
    `- status: ${detail.status}${detail.visibility && detail.visibility !== 'public' ? ` (${detail.visibility})` : ''}`,
    `- published: ${detail.published_at ?? 'not published'}`,
    `- updated: ${detail.updated_at ?? 'unknown'}`,
    detail.tags.length ? `- tags: ${detail.tags.join(', ')}` : '',
    detail.authors.length ? `- authors: ${detail.authors.join(', ')}` : '',
    `- words: ${detail.word_count}`,
    detail.custom_excerpt ? `- excerpt: ${detail.custom_excerpt}` : ''
  ].filter((line) => line !== '');
  const footer = detail.truncated ? `\n\n[Truncated at ${detail.content.length} characters. Raise max_characters to read more.]` : '';
  const text = `${header.join('\n')}\n\n---\n\n${detail.content}${footer}`;
  return { content: [{ type: 'text', text }], structuredContent: { ...detail } };
}

const STATUSES = ['all', 'published', 'draft', 'scheduled'] as const;
const ORDERS = ['newest', 'oldest', 'recently_updated'] as const;
const FORMATS = ['text', 'html'] as const;

async function callTool(name: string, rawArgs: unknown, context: McpContext): Promise<ToolResult> {
  if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
    return toolError('Tool arguments must be an object.');
  }
  const args = (rawArgs ?? {}) as Args;
  if (!context.ghost) return toolError('Ghost is not configured on this Worker (GHOST_URL and GHOST_ADMIN_API_KEY).');
  const ghost = context.ghost;

  try {
    if (name === 'search_posts' || name === 'search_pages') {
      allowOnly(args, ['query', 'tag', 'status', 'order', 'limit', 'page']);
      const type: GhostContentType = name === 'search_posts' ? 'posts' : 'pages';
      const result = await searchContent(ghost, type, {
        query: optionalString(args, 'query', 200),
        tag: optionalString(args, 'tag', 200),
        status: optionalEnum<GhostStatusFilter>(args, 'status', STATUSES),
        order: optionalEnum<GhostOrder>(args, 'order', ORDERS),
        limit: optionalInteger(args, 'limit', 1, 50),
        page: optionalInteger(args, 'page', 1, 10_000)
      });
      return jsonResult({ ...result });
    }

    if (name === 'get_post' || name === 'get_page') {
      allowOnly(args, ['id', 'slug', 'url', 'format', 'max_characters']);
      const type: GhostContentType = name === 'get_post' ? 'posts' : 'pages';
      const detail = await getContent(
        ghost,
        type,
        { id: optionalString(args, 'id', 64), slug: optionalString(args, 'slug', 200), url: optionalString(args, 'url', 2000) },
        { format: optionalEnum(args, 'format', FORMATS), maxCharacters: optionalInteger(args, 'max_characters', 1000, 200_000) }
      );
      if (!detail) return toolError(`No ${type === 'posts' ? 'post' : 'page'} matched that lookup.`);
      return detailResult(detail);
    }

    if (name === 'list_tags') {
      allowOnly(args, ['query', 'include_internal', 'limit', 'page']);
      const result = await listTags(ghost, {
        query: optionalString(args, 'query', 200),
        includeInternal: optionalBoolean(args, 'include_internal'),
        limit: optionalInteger(args, 'limit', 1, 100),
        page: optionalInteger(args, 'page', 1, 10_000)
      });
      return jsonResult({ ...result });
    }
  } catch (error) {
    if (error instanceof InvalidArguments || error instanceof LookupError) return toolError(error.message);
    if (error instanceof UpstreamError) {
      console.warn(JSON.stringify({ message: 'mcp tool upstream error', tool: name, status: error.status }));
      return toolError(`Ghost returned an error (${error.status}). Try again shortly.`);
    }
    if (error instanceof Error && error.message === 'Ghost tag is required') return toolError('tag is empty after normalizing.');
    console.error(JSON.stringify({ message: 'mcp tool failed', tool: name, error: error instanceof Error ? error.message : String(error) }));
    return toolError('The tool failed unexpectedly.');
  }

  throw new UnknownTool(name);
}

class UnknownTool extends Error {}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'] | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string';
}

async function handleMessage(message: unknown, context: McpContext): Promise<object | null> {
  if (!isRequest(message)) {
    // Responses from the client (we never send requests) and malformed input.
    const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
    if ('result' in record || 'error' in record) return null;
    return rpcError(null, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in message);
  if (isNotification) return null;

  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS
      });
    }
    case 'ping':
      return rpcResult(message.id, {});
    case 'tools/list':
      return rpcResult(message.id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS.some((tool) => tool.name === name)) return rpcError(message.id, -32602, `Unknown tool: ${name || '(missing)'}`);
      try {
        return rpcResult(message.id, await callTool(name, params.arguments, context));
      } catch (error) {
        if (error instanceof UnknownTool) return rpcError(message.id, -32602, `Unknown tool: ${name}`);
        throw error;
      }
    }
    case 'resources/list':
    case 'prompts/list':
      return rpcError(message.id, -32601, `Method not supported: ${message.method}`);
    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

/**
 * Handles one POSTed JSON-RPC payload (a message or a batch). Returns null
 * when there is nothing to send back (notifications and client responses),
 * which the HTTP layer turns into 202 Accepted.
 */
export async function handleMcpPayload(payload: unknown, context: McpContext): Promise<object | object[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return rpcError(null, -32600, 'Invalid Request');
    const responses = (await Promise.all(payload.slice(0, 20).map((message) => handleMessage(message, context))))
      .filter((response): response is object => response !== null);
    return responses.length ? responses : null;
  }
  return handleMessage(payload, context);
}

export function parseErrorResponse() {
  return rpcError(null, -32700, 'Parse error');
}
