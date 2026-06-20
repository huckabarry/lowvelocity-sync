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

function assertGhostPost(post: GhostPost | undefined): GhostPost {
  if (!post?.id || !post.slug || !post.title || !post.status || !post.url || !post.published_at || !post.updated_at) {
    throw new Error('Ghost returned an incomplete post');
  }
  return post;
}

async function ghostHeaders(config: SyncConfig): Promise<HeadersInit> {
  return {
    Accept: 'application/json',
    'Accept-Version': 'v5.0',
    Authorization: `Ghost ${await createGhostAdminToken(config.ghostAdminApiKey)}`
  };
}

export async function readGhostPost(config: SyncConfig, postId: string): Promise<GhostPost> {
  const url = new URL(`/ghost/api/admin/posts/${encodeURIComponent(postId)}/`, config.ghostUrl);
  url.searchParams.set('formats', 'html');
  url.searchParams.set('include', 'tags');
  const response = await fetch(url, { headers: await ghostHeaders(config) });
  const body = await readJsonResponse<GhostPostsResponse>(response, 'Ghost Admin API');
  return assertGhostPost(body.posts?.[0]);
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
