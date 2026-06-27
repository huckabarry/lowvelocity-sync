import { createGhostAdminToken } from './crypto.ts';
import { readJsonResponse } from './http.ts';
import type { SyncConfig } from './config.ts';

export interface GhostTag { name?: string; visibility?: string; }

export interface GhostPost {
  id: string;
  slug: string;
  title: string;
  status: string;
  url: string;
  published_at: string;
  updated_at: string;
  custom_excerpt?: string | null;
  excerpt?: string | null;
  html?: string | null;
  feature_image?: string | null;
  codeinjection_head?: string | null;
  codeinjection_foot?: string | null;
  tags?: GhostTag[];
}

interface GhostPostsResponse { posts?: GhostPost[]; }
interface GhostPagesResponse { pages?: GhostPost[]; }
interface GhostImagesResponse { images?: { url?: string }[]; }

interface GhostIdentitiesResponse { identities?: { token?: string }[]; errors?: { message?: string }[]; }

export interface GhostActivityPubNote {
  id: string;
  type: number;
  content: string;
  url: string;
  publishedAt: string;
}

interface GhostActivityPubNoteResponse {
  post?: GhostActivityPubNote;
  error?: string;
}

function assertGhostPost(post: GhostPost | undefined): GhostPost {
  if (!post?.id || !post.slug || !post.title || !post.status || !post.url || !post.published_at || !post.updated_at) {
    throw new Error('Ghost returned an incomplete post');
  }
  return post;
}

export async function ghostHeaders(config: SyncConfig): Promise<HeadersInit> {
  return {
    Accept: 'application/json',
    'Accept-Version': 'v5.0',
    Authorization: `Ghost ${await createGhostAdminToken(config.ghostAdminApiKey)}`
  };
}

async function ghostStaffHeaders(config: SyncConfig): Promise<HeadersInit> {
  if (!config.ghostStaffAccessToken) {
    throw new Error('Ghost staff access token is not configured');
  }
  return {
    Accept: 'application/json',
    'Accept-Version': 'v6.0',
    Authorization: `Ghost ${await createGhostAdminToken(config.ghostStaffAccessToken)}`
  };
}

export async function readGhostActivityPubIdentityToken(config: SyncConfig): Promise<string> {
  const url = new URL('/ghost/api/admin/identities/', config.ghostUrl);
  const response = await fetch(url, { headers: await ghostStaffHeaders(config) });
  const body = await readJsonResponse<GhostIdentitiesResponse>(response, 'Ghost Admin identities API');
  const token = body.identities?.[0]?.token;
  if (!token) {
    throw new Error(body.errors?.[0]?.message ?? 'Ghost did not return an ActivityPub identity token');
  }
  return token;
}

export async function createGhostActivityPubNote(
  config: SyncConfig,
  content: string,
  image?: { url: string; altText?: string }
): Promise<GhostActivityPubNote> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('ActivityPub note content is required');
  if (trimmed.length > 5000) throw new Error('ActivityPub note content is too long');

  const identityToken = await readGhostActivityPubIdentityToken(config);
  const url = new URL('/.ghost/activitypub/v1/actions/note', config.ghostUrl);
  const body: { content: string; image?: { url: string; altText?: string } } = { content: trimmed };
  if (image) body.image = image;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${identityToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const result = await readJsonResponse<GhostActivityPubNoteResponse>(response, 'Ghost ActivityPub API');
  if (!result.post?.id || !result.post.url) {
    throw new Error(result.error ?? 'Ghost ActivityPub API did not return a note');
  }
  return result.post;
}

export async function readGhostPost(config: SyncConfig, postId: string): Promise<GhostPost> {
  const url = new URL(`/ghost/api/admin/posts/${encodeURIComponent(postId)}/`, config.ghostUrl);
  url.searchParams.set('formats', 'html');
  url.searchParams.set('include', 'tags');
  const response = await fetch(url, { headers: await ghostHeaders(config) });
  const body = await readJsonResponse<GhostPostsResponse>(response, 'Ghost Admin API');
  return assertGhostPost(body.posts?.[0]);
}

export async function findGhostPostBySlug(
  config: SyncConfig,
  slug: string,
  type: 'posts' | 'pages' = 'posts'
): Promise<GhostPost | null> {
  const url = new URL(`/ghost/api/admin/${type}/`, config.ghostUrl);
  url.searchParams.set('formats', 'html');
  url.searchParams.set('include', 'tags');
  url.searchParams.set('filter', `slug:${slug}`);
  url.searchParams.set('limit', '1');
  const response = await fetch(url, { headers: await ghostHeaders(config) });
  const body = await readJsonResponse<GhostPostsResponse & GhostPagesResponse>(response, 'Ghost Admin API');
  return (type === 'pages' ? body.pages?.[0] : body.posts?.[0]) ?? null;
}

function ghostTagFilterValue(tag: string): string {
  const normalized = String(tag || '').trim().toLowerCase();
  const internal = normalized.startsWith('#');
  const slug = normalized
    .replace(/^#/, '')
    .replace(/['".,!?()[\]{}:;]+/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Ghost tag is required');
  return internal ? `hash-${slug}` : slug;
}

export async function findLatestGhostPostByTag(config: SyncConfig, tag: string): Promise<GhostPost | null> {
  const url = new URL('/ghost/api/admin/posts/', config.ghostUrl);
  url.searchParams.set('formats', 'html');
  url.searchParams.set('include', 'tags');
  url.searchParams.set('filter', `tag:${ghostTagFilterValue(tag)}+status:published`);
  url.searchParams.set('order', 'published_at desc');
  url.searchParams.set('limit', '1');
  const response = await fetch(url, { headers: await ghostHeaders(config) });
  const body = await readJsonResponse<GhostPostsResponse>(response, 'Ghost Admin API');
  return body.posts?.[0] ?? null;
}

export interface GhostHtmlEntryInput {
  slug: string;
  title: string;
  html: string;
  custom_excerpt?: string;
  feature_image?: string | null;
  published_at?: string;
  tags?: Array<{ name: string }>;
  status?: 'draft' | 'published';
}

export async function createGhostHtmlEntry(
  config: SyncConfig,
  input: GhostHtmlEntryInput,
  type: 'posts' | 'pages' = 'posts'
): Promise<GhostPost> {
  const url = new URL(`/ghost/api/admin/${type}/`, config.ghostUrl);
  url.searchParams.set('source', 'html');
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...(await ghostHeaders(config)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ [type]: [{ status: 'published', ...input }] })
  });
  const body = await readJsonResponse<GhostPostsResponse & GhostPagesResponse>(response, 'Ghost Admin API');
  return assertGhostPost(type === 'pages' ? body.pages?.[0] : body.posts?.[0]);
}

export async function updateGhostHtmlEntry(
  config: SyncConfig,
  existing: GhostPost,
  input: GhostHtmlEntryInput,
  type: 'posts' | 'pages' = 'posts'
): Promise<GhostPost> {
  const url = new URL(`/ghost/api/admin/${type}/${encodeURIComponent(existing.id)}/`, config.ghostUrl);
  url.searchParams.set('source', 'html');
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...(await ghostHeaders(config)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ [type]: [{ id: existing.id, updated_at: existing.updated_at, ...input }] })
  });
  const body = await readJsonResponse<GhostPostsResponse & GhostPagesResponse>(response, 'Ghost Admin API');
  return assertGhostPost(type === 'pages' ? body.pages?.[0] : body.posts?.[0]);
}

export async function uploadGhostImageFromUrl(config: SyncConfig, imageUrl: string, filename: string): Promise<string | null> {
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) return null;
  const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
  const blob = new Blob([await imageResponse.arrayBuffer()], { type: contentType });
  const form = new FormData();
  form.set('file', blob, filename);
  form.set('purpose', 'image');

  const uploadUrl = new URL('/ghost/api/admin/images/upload/', config.ghostUrl);
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: await ghostHeaders(config),
    body: form
  });
  const body = await readJsonResponse<GhostImagesResponse>(response, 'Ghost Admin images API');
  return body.images?.[0]?.url ?? null;
}

const MARKER_START = '<!-- standard.site:document -->';
const MARKER_END = '<!-- /standard.site:document -->';
const MARKER_PATTERN = /<!-- standard\.site:document -->[\s\S]*?<!-- \/standard\.site:document -->\n?/g;
const LEGACY_MARKER_PATTERN = /<!-- apparition:standard-site -->[\s\S]*?<!-- \/apparition:standard-site -->\n?/g;

export function buildDocumentLinkInjection(existing: string | null | undefined, atUri: string): string {
  if (!/^at:\/\/did:[a-z0-9:%._-]+\/site\.standard\.document\/[A-Za-z0-9._:~-]+$/.test(atUri)) {
    throw new Error('Invalid Standard.site document AT-URI');
  }
  const stripped = (existing ?? '').replace(MARKER_PATTERN, '').trimEnd();
  const block = `${MARKER_START}\n<link rel="site.standard.document" href="${atUri}">\n${MARKER_END}`;
  return stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
}

export async function setDocumentLink(config: SyncConfig, post: GhostPost, atUri: string): Promise<boolean> {
  const desiredHead = buildDocumentLinkInjection(post.codeinjection_head, atUri);
  const desiredFoot = (post.codeinjection_foot ?? '').replace(LEGACY_MARKER_PATTERN, '').trim();
  const headChanged = desiredHead !== (post.codeinjection_head ?? '');
  const footChanged = desiredFoot !== (post.codeinjection_foot ?? '').trim();
  if (!headChanged && !footChanged) return false;
  const url = new URL(`/ghost/api/admin/posts/${encodeURIComponent(post.id)}/`, config.ghostUrl);
  const update: Record<string, string> = { id: post.id, updated_at: post.updated_at };
  if (headChanged) update.codeinjection_head = desiredHead;
  if (footChanged) update.codeinjection_foot = desiredFoot;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...(await ghostHeaders(config)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ posts: [update] })
  });
  await readJsonResponse<GhostPostsResponse>(response, 'Ghost Admin API');
  return true;
}
