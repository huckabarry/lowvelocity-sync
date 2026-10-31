// Read-only Ghost Admin API helpers used by the MCP tools. Nothing in this
// module issues anything other than GET requests.

import { ghostHeaders, ghostTagFilterValue } from '../ghost.ts';
import { readJsonResponse, UpstreamError } from '../http.ts';
import { htmlToPlainText } from '../transform.ts';

export interface GhostReadConfig {
  ghostUrl: string;
  ghostAdminApiKey: string;
}

export type GhostContentType = 'posts' | 'pages';
export type GhostStatusFilter = 'all' | 'published' | 'draft' | 'scheduled';
export type GhostOrder = 'newest' | 'oldest' | 'recently_updated';

interface GhostTagRecord {
  id?: string;
  name?: string;
  slug?: string;
  visibility?: string;
  description?: string | null;
  count?: { posts?: number };
}

interface GhostAuthorRecord {
  name?: string;
  slug?: string;
}

export interface GhostContentRecord {
  id: string;
  uuid?: string;
  title: string;
  slug: string;
  status: string;
  visibility?: string;
  url: string;
  featured?: boolean;
  created_at?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  custom_excerpt?: string | null;
  excerpt?: string | null;
  feature_image?: string | null;
  canonical_url?: string | null;
  meta_title?: string | null;
  meta_description?: string | null;
  html?: string | null;
  plaintext?: string | null;
  tags?: GhostTagRecord[];
  authors?: GhostAuthorRecord[];
}

interface GhostPagination {
  page?: number;
  limit?: number | string;
  pages?: number;
  total?: number;
  next?: number | null;
  prev?: number | null;
}

interface GhostListResponse {
  posts?: GhostContentRecord[];
  pages?: GhostContentRecord[];
  tags?: GhostTagRecord[];
  meta?: { pagination?: GhostPagination };
}

export function ghostReadConfig(env: { GHOST_URL?: unknown; GHOST_ADMIN_API_KEY?: unknown } | undefined): GhostReadConfig | null {
  const ghostUrl = typeof env?.GHOST_URL === 'string' ? env.GHOST_URL.trim().replace(/\/$/, '') : '';
  const ghostAdminApiKey = typeof env?.GHOST_ADMIN_API_KEY === 'string' ? env.GHOST_ADMIN_API_KEY.trim() : '';
  return ghostUrl && ghostAdminApiKey ? { ghostUrl, ghostAdminApiKey } : null;
}

/** Quotes a value for Ghost's NQL filter syntax. */
export function nqlString(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return `'${cleaned.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function orderClause(order: GhostOrder): string {
  if (order === 'oldest') return 'published_at asc';
  if (order === 'recently_updated') return 'updated_at desc';
  return 'published_at desc';
}

async function ghostGet(config: GhostReadConfig, path: string, params: Record<string, string>): Promise<GhostListResponse> {
  const url = new URL(path, config.ghostUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: await ghostHeaders(config) });
  return readJsonResponse<GhostListResponse>(response, 'Ghost Admin API');
}

function excerptFor(record: GhostContentRecord, max = 280): string {
  const source = (record.custom_excerpt || record.excerpt || record.plaintext || '').replace(/\s+/g, ' ').trim();
  return source.length > max ? `${source.slice(0, max - 1).trimEnd()}…` : source;
}

function tagNames(record: GhostContentRecord): string[] {
  return (record.tags ?? []).map((tag) => tag.name ?? '').filter(Boolean);
}

export interface SearchOptions {
  query?: string;
  tag?: string;
  status?: GhostStatusFilter;
  order?: GhostOrder;
  limit?: number;
  page?: number;
}

export interface ContentSummary {
  id: string;
  title: string;
  slug: string;
  status: string;
  visibility?: string;
  url: string;
  published_at: string | null;
  updated_at: string | null;
  tags: string[];
  excerpt: string;
}

export interface SearchResult {
  type: GhostContentType;
  filter: string | null;
  results: ContentSummary[];
  pagination: { page: number; pages: number; total: number; next: number | null };
}

export async function searchContent(config: GhostReadConfig, type: GhostContentType, options: SearchOptions = {}): Promise<SearchResult> {
  const filters: string[] = [];
  const query = options.query?.trim();
  if (query) filters.push(`title:~${nqlString(query)}`);
  if (options.tag?.trim()) filters.push(`tag:${ghostTagFilterValue(options.tag)}`);
  const status = options.status ?? 'all';
  if (status !== 'all') filters.push(`status:${status}`);
  const filter = filters.length ? filters.join('+') : null;
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 15)));
  const page = Math.max(1, Math.trunc(options.page ?? 1));

  const params: Record<string, string> = {
    formats: 'plaintext',
    include: 'tags',
    limit: String(limit),
    page: String(page),
    order: orderClause(options.order ?? 'newest')
  };
  if (filter) params.filter = filter;

  const body = await ghostGet(config, `/ghost/api/admin/${type}/`, params);
  const records = (type === 'pages' ? body.pages : body.posts) ?? [];
  const pagination = body.meta?.pagination ?? {};
  return {
    type,
    filter,
    results: records.map((record) => ({
      id: record.id,
      title: record.title,
      slug: record.slug,
      status: record.status,
      visibility: record.visibility,
      url: record.url,
      published_at: record.published_at ?? null,
      updated_at: record.updated_at ?? null,
      tags: tagNames(record),
      excerpt: excerptFor(record)
    })),
    pagination: {
      page: pagination.page ?? page,
      pages: pagination.pages ?? 1,
      total: pagination.total ?? records.length,
      next: pagination.next ?? null
    }
  };
}

export interface ContentLookup {
  id?: string;
  slug?: string;
  url?: string;
}

export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookupError';
  }
}

const GHOST_ID = /^[a-f0-9]{24}$/i;

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** Resolves a lookup to the Ghost Admin API path that fetches it. */
export function lookupPath(config: GhostReadConfig, type: GhostContentType, lookup: ContentLookup): string {
  const provided = [lookup.id, lookup.slug, lookup.url].filter((value) => typeof value === 'string' && value.trim() !== '');
  if (provided.length !== 1) throw new LookupError('Provide exactly one of id, slug, or url.');

  if (lookup.id?.trim()) {
    const id = lookup.id.trim();
    if (!GHOST_ID.test(id)) throw new LookupError('id must be a 24-character Ghost ID.');
    return `/ghost/api/admin/${type}/${id}/`;
  }

  let slug = lookup.slug?.trim() ?? '';
  if (lookup.url?.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(lookup.url.trim());
    } catch {
      throw new LookupError('url must be an absolute URL.');
    }
    if (normalizedHost(parsed.hostname) !== normalizedHost(new URL(config.ghostUrl).hostname)) {
      throw new LookupError(`url must be on ${new URL(config.ghostUrl).hostname}.`);
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'p') throw new LookupError('Preview links are not supported. Use the post id or slug instead.');
    slug = decodeURIComponent(segments.at(-1) ?? '');
  }

  if (!slug || slug.length > 191 || /[\s/?#]/.test(slug)) throw new LookupError('slug is missing or invalid.');
  return `/ghost/api/admin/${type}/slug/${encodeURIComponent(slug)}/`;
}

export interface ContentDetail extends ContentSummary {
  type: GhostContentType;
  featured: boolean;
  created_at: string | null;
  authors: string[];
  feature_image: string | null;
  canonical_url: string | null;
  meta_title: string | null;
  meta_description: string | null;
  custom_excerpt: string | null;
  word_count: number;
  format: 'text' | 'html';
  content: string;
  truncated: boolean;
}

export async function getContent(
  config: GhostReadConfig,
  type: GhostContentType,
  lookup: ContentLookup,
  options: { format?: 'text' | 'html'; maxCharacters?: number } = {}
): Promise<ContentDetail | null> {
  const path = lookupPath(config, type, lookup);
  let body: GhostListResponse;
  try {
    body = await ghostGet(config, path, { formats: 'html,plaintext', include: 'tags,authors' });
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
  const record = (type === 'pages' ? body.pages : body.posts)?.[0];
  if (!record) return null;

  const format = options.format ?? 'text';
  const plaintext = (record.plaintext ?? '').trim() || htmlToPlainText(record.html ?? '');
  const full = format === 'html' ? record.html ?? '' : plaintext;
  const maxCharacters = Math.max(1000, Math.min(200_000, Math.trunc(options.maxCharacters ?? 50_000)));
  const truncated = full.length > maxCharacters;

  return {
    type,
    id: record.id,
    title: record.title,
    slug: record.slug,
    status: record.status,
    visibility: record.visibility,
    url: record.url,
    featured: Boolean(record.featured),
    created_at: record.created_at ?? null,
    published_at: record.published_at ?? null,
    updated_at: record.updated_at ?? null,
    tags: tagNames(record),
    authors: (record.authors ?? []).map((author) => author.name ?? '').filter(Boolean),
    excerpt: excerptFor(record),
    custom_excerpt: record.custom_excerpt ?? null,
    feature_image: record.feature_image ?? null,
    canonical_url: record.canonical_url ?? null,
    meta_title: record.meta_title ?? null,
    meta_description: record.meta_description ?? null,
    word_count: plaintext ? plaintext.split(/\s+/).filter(Boolean).length : 0,
    format,
    content: truncated ? full.slice(0, maxCharacters) : full,
    truncated
  };
}

export interface TagSummary {
  name: string;
  slug: string;
  visibility: string;
  posts: number | null;
  description: string | null;
}

export async function listTags(
  config: GhostReadConfig,
  options: { query?: string; includeInternal?: boolean; limit?: number; page?: number } = {}
) {
  const filters: string[] = [];
  if (!options.includeInternal) filters.push('visibility:public');
  if (options.query?.trim()) filters.push(`name:~${nqlString(options.query.trim())}`);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const params: Record<string, string> = {
    include: 'count.posts',
    limit: String(limit),
    page: String(page),
    order: 'name asc'
  };
  if (filters.length) params.filter = filters.join('+');

  const body = await ghostGet(config, '/ghost/api/admin/tags/', params);
  const pagination = body.meta?.pagination ?? {};
  return {
    tags: (body.tags ?? []).map((tag): TagSummary => ({
      name: tag.name ?? '',
      slug: tag.slug ?? '',
      visibility: tag.visibility ?? 'public',
      posts: tag.count?.posts ?? null,
      description: tag.description ?? null
    })),
    pagination: {
      page: pagination.page ?? page,
      pages: pagination.pages ?? 1,
      total: pagination.total ?? (body.tags ?? []).length,
      next: pagination.next ?? null
    }
  };
}
