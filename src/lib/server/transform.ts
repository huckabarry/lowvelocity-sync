import type { GhostPost } from './ghost.ts';

export const DOCUMENT_COLLECTION = 'site.standard.document';

export interface StandardDocument {
  $type: typeof DOCUMENT_COLLECTION;
  site: string;
  path: string;
  title: string;
  publishedAt: string;
  updatedAt?: string;
  description?: string;
  textContent?: string;
  tags?: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, key: string) => {
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return ENTITIES[key.toLowerCase()] ?? entity;
  });
}

export function htmlToPlainText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|blockquote|h[1-6]|figcaption)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(value: string, max: number): string {
  return Array.from(value.trim()).slice(0, max).join('');
}

export function ghostPostToDocument(post: GhostPost, publicationUri: string): StandardDocument {
  const record: StandardDocument = {
    $type: DOCUMENT_COLLECTION,
    site: publicationUri,
    path: new URL(post.url).pathname,
    title: truncate(post.title, 500),
    publishedAt: post.published_at
  };
  const description = post.custom_excerpt || post.excerpt;
  if (description?.trim()) record.description = truncate(description, 3000);
  if (post.updated_at !== post.published_at) record.updatedAt = post.updated_at;
  const textContent = post.html ? htmlToPlainText(post.html) : '';
  if (textContent) record.textContent = textContent;
  const tags = (post.tags ?? [])
    .filter((tag) => tag.visibility !== 'internal' && !tag.name?.startsWith('#'))
    .map((tag) => truncate(tag.name ?? '', 128))
    .filter(Boolean);
  if (tags.length) record.tags = [...new Set(tags)];
  return record;
}
