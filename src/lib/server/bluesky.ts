import type { SyncConfig } from './config.ts';
import { readJsonResponse } from './http.ts';

export const BLUESKY_UPDATES_LIMIT = 25;

interface BlueskyAuthor {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
}

interface BlueskyPostRecord {
  text?: string;
  createdAt?: string;
  reply?: unknown;
}

interface BlueskyImageView {
  thumb?: string;
  thumbnail?: string;
  fullsize?: string;
  alt?: string;
  aspectRatio?: {
    width?: number;
    height?: number;
  };
}

interface BlueskyExternalView {
  uri?: string;
  title?: string;
  description?: string;
  thumb?: string;
}

interface BlueskyRecordView {
  uri?: string;
  cid?: string;
  author?: BlueskyAuthor;
  value?: BlueskyPostRecord;
  embeds?: BlueskyEmbedView[];
}

interface BlueskyEmbedView {
  $type?: string;
  images?: BlueskyImageView[];
  items?: BlueskyImageView[];
  external?: BlueskyExternalView;
  record?: BlueskyRecordView;
  media?: BlueskyEmbedView;
}

interface BlueskyFeedItem {
  post?: {
    uri?: string;
    cid?: string;
    author?: BlueskyAuthor;
    record?: BlueskyPostRecord;
    embed?: BlueskyEmbedView;
    likeCount?: number;
    replyCount?: number;
    repostCount?: number;
    quoteCount?: number;
  };
  reason?: unknown;
}

interface BlueskyAuthorFeedResponse {
  feed?: BlueskyFeedItem[];
  cursor?: string;
}

export interface BlueskyUpdateImage {
  type: 'image';
  url: string;
  thumb?: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface BlueskyUpdateExternal {
  type: 'external';
  uri: string;
  title?: string;
  description?: string;
  thumb?: string;
}

export interface BlueskyUpdateQuote {
  type: 'quote';
  uri: string;
  cid?: string;
  author?: {
    did?: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
  };
  text?: string;
  createdAt?: string;
  embeds?: BlueskyUpdateEmbed[];
}

export type BlueskyUpdateEmbed = BlueskyUpdateImage | BlueskyUpdateExternal | BlueskyUpdateQuote;

export interface BlueskyUpdate {
  uri: string;
  cid?: string;
  url: string;
  text: string;
  createdAt: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  counts: {
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
  };
  embeds: BlueskyUpdateEmbed[];
}

export interface BlueskyUpdatesResponse {
  source: {
    did: string;
    handle: string;
  };
  fetchedAt: string;
  limit: number;
  items: BlueskyUpdate[];
}

function blueskyPostUrl(handle: string, uri: string): string {
  const rkey = uri.split('/').at(-1);
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey ?? uri)}`;
}

function normalizeImages(embed: BlueskyEmbedView | undefined): BlueskyUpdateImage[] {
  const images = embed?.images ?? embed?.items ?? [];
  return images
    .map((image) => {
      const url = image.fullsize ?? image.thumb ?? image.thumbnail;
      if (!url) return null;
      return {
        type: 'image' as const,
        url,
        thumb: image.thumb ?? image.thumbnail,
        alt: image.alt ?? '',
        width: image.aspectRatio?.width,
        height: image.aspectRatio?.height
      };
    })
    .filter((image): image is BlueskyUpdateImage => Boolean(image));
}

function normalizeExternal(embed: BlueskyEmbedView | undefined): BlueskyUpdateExternal[] {
  const external = embed?.external;
  if (!external?.uri) return [];
  return [{
    type: 'external',
    uri: external.uri,
    title: external.title,
    description: external.description,
    thumb: external.thumb
  }];
}

function normalizeQuote(embed: BlueskyEmbedView | undefined): BlueskyUpdateQuote[] {
  const record = embed?.record;
  if (!record?.uri) return [];
  return [{
    type: 'quote',
    uri: record.uri,
    cid: record.cid,
    author: record.author,
    text: record.value?.text,
    createdAt: record.value?.createdAt,
    embeds: normalizeEmbeds(record.embeds?.[0])
  }];
}

function normalizeEmbeds(embed: BlueskyEmbedView | undefined): BlueskyUpdateEmbed[] {
  const mediaEmbeds = embed?.media ? normalizeEmbeds(embed.media) : [];
  return [
    ...normalizeImages(embed),
    ...normalizeExternal(embed),
    ...normalizeQuote(embed),
    ...mediaEmbeds
  ];
}

export function normalizeBlueskyFeedItem(item: BlueskyFeedItem, expectedDid: string): BlueskyUpdate | null {
  const post = item.post;
  const author = post?.author;
  const record = post?.record;
  if (!post?.uri || !record?.createdAt || !author?.did || !author.handle) return null;
  if (author.did !== expectedDid) return null;
  if (item.reason || record.reply) return null;
  return {
    uri: post.uri,
    cid: post.cid,
    url: blueskyPostUrl(author.handle, post.uri),
    text: record.text ?? '',
    createdAt: record.createdAt,
    author: {
      did: author.did,
      handle: author.handle,
      displayName: author.displayName,
      avatar: author.avatar
    },
    counts: {
      likes: post.likeCount ?? 0,
      replies: post.replyCount ?? 0,
      reposts: post.repostCount ?? 0,
      quotes: post.quoteCount ?? 0
    },
    embeds: normalizeEmbeds(post.embed)
  };
}

export async function readBlueskyUpdates(config: SyncConfig, limit = BLUESKY_UPDATES_LIMIT): Promise<BlueskyUpdatesResponse> {
  const items: BlueskyUpdate[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 5 && items.length < limit; page += 1) {
    const url = new URL('/xrpc/app.bsky.feed.getAuthorFeed', 'https://public.api.bsky.app');
    url.searchParams.set('actor', config.atprotoDid);
    url.searchParams.set('filter', 'posts_with_replies');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url);
    const body = await readJsonResponse<BlueskyAuthorFeedResponse>(response, 'Bluesky public API');
    for (const feedItem of body.feed ?? []) {
      const update = normalizeBlueskyFeedItem(feedItem, config.atprotoDid);
      if (update) items.push(update);
      if (items.length >= limit) break;
    }
    cursor = body.cursor;
    if (!cursor) break;
  }

  return {
    source: {
      did: config.atprotoDid,
      handle: config.atprotoIdentifier
    },
    fetchedAt: new Date().toISOString(),
    limit,
    items
  };
}
