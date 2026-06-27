import {
  blueskyPostRkey,
  readBlueskyUpdatesWindow,
  type BlueskyUpdate,
  type BlueskyUpdateEmbed,
  type BlueskyUpdateExternal,
  type BlueskyUpdateImage,
  type BlueskyUpdateQuote,
  type BlueskyUpdateVideo
} from './bluesky.ts';
import type { SyncConfig } from './config.ts';
import { createGhostHtmlEntry, findGhostPostBySlug, updateGhostHtmlEntry, uploadGhostImageFromUrl } from './ghost.ts';

export interface ImportBlueskyPostsOptions {
  dryRun?: boolean;
  limit?: number;
  maxPages?: number;
  since?: string;
  until?: string;
  updateExisting?: boolean;
  uploadImages?: boolean;
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkifyEscapedText(value: string): string {
  return escapeHtml(value).replace(
    /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g,
    '<a href="$1" rel="noopener">$1</a>'
  );
}

function textHtml(value: string): string {
  const paragraphs = String(value || '')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs
    .map((paragraph) => `<p>${linkifyEscapedText(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function stripText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugForUpdate(update: BlueskyUpdate): string {
  return `bsky-${blueskyPostRkey(update.uri)}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 180);
}

function titleForUpdate(update: BlueskyUpdate): string {
  const text = stripText(update.text);
  if (!text) return `Photo update — ${update.createdAt.slice(0, 10)}`;
  const words = text.split(/\s+/);
  return `${words.slice(0, 9).join(' ')}${words.length > 9 ? '…' : ''}`;
}

function imageFilename(update: BlueskyUpdate, index: number): string {
  return `${slugForUpdate(update)}-${index + 1}.jpg`;
}

function externalImageFilename(update: BlueskyUpdate, index: number, url: string): string {
  const extension = /\.gif(?:[?#]|$)/i.test(url) ? 'gif' : 'jpg';
  return `${slugForUpdate(update)}-external-${index + 1}.${extension}`;
}

function videoPosterFilename(update: BlueskyUpdate, index: number): string {
  return `${slugForUpdate(update)}-video-${index + 1}.jpg`;
}

async function tryUploadGhostImageFromUrl(config: SyncConfig, imageUrl: string, filename: string): Promise<string | null> {
  try {
    return await uploadGhostImageFromUrl(config, imageUrl, filename);
  } catch (error) {
    console.warn(JSON.stringify({
      message: 'unable to upload Bluesky embed image to Ghost',
      imageUrl,
      filename,
      error: error instanceof Error ? error.message : 'Unknown error'
    }));
    return null;
  }
}

function isAnimatedGifExternal(external: BlueskyUpdateExternal): boolean {
  try {
    return new URL(external.uri).pathname.toLowerCase().endsWith('.gif');
  } catch {
    return /\.gif(?:[?#]|$)/i.test(external.uri);
  }
}

function imageHtml(image: BlueskyUpdateImage): string {
  const width = image.width ? ` width="${image.width}"` : '';
  const height = image.height ? ` height="${image.height}"` : '';
  return [
    '<figure class="kg-card kg-image-card lv-atproto-image">',
    `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}"${width}${height} loading="lazy">`,
    image.alt ? `<figcaption>${escapeHtml(image.alt)}</figcaption>` : '',
    '</figure>'
  ].filter(Boolean).join('\n');
}

function externalHtml(external: BlueskyUpdateExternal): string {
  if (isAnimatedGifExternal(external)) {
    return [
      '<figure class="kg-card kg-image-card lv-atproto-gif">',
      `<img class="kg-image status-external-gif" src="${escapeHtml(external.thumb || external.uri)}" alt="${escapeHtml(external.description || external.title || '')}" loading="lazy">`,
      external.title || external.uri ? `<figcaption><a href="${escapeHtml(external.uri)}" rel="noopener">${escapeHtml(external.title || external.uri)}</a></figcaption>` : '',
      '</figure>'
    ].filter(Boolean).join('\n');
  }

  return [
    '<figure class="kg-card kg-bookmark-card lv-atproto-card">',
    `<a class="kg-bookmark-container" href="${escapeHtml(external.uri)}" rel="noopener">`,
    '<div class="kg-bookmark-content">',
    `<div class="kg-bookmark-title">${external.title ? escapeHtml(external.title) : escapeHtml(external.uri)}</div>`,
    external.description ? `<div class="kg-bookmark-description">${escapeHtml(external.description)}</div>` : '',
    '<div class="kg-bookmark-metadata">',
    `<span class="kg-bookmark-publisher">${escapeHtml(externalDomain(external.uri))}</span>`,
    '</div>',
    '</div>',
    external.thumb ? `<div class="kg-bookmark-thumbnail"><img src="${escapeHtml(external.thumb)}" alt="" loading="lazy"></div>` : '',
    '</a>',
    '</figure>'
  ].filter(Boolean).join('\n');
}

function externalDomain(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function videoHtml(video: BlueskyUpdateVideo): string {
  const width = video.width ? ` width="${video.width}"` : '';
  const height = video.height ? ` height="${video.height}"` : '';
  const poster = video.thumbnail ? ` poster="${escapeHtml(video.thumbnail)}"` : '';
  return [
    '<figure class="kg-card kg-video-card lv-atproto-video status-video">',
    `<video controls playsinline preload="metadata" src="${escapeHtml(video.playlist)}"${poster}${width}${height}></video>`,
    video.alt ? `<figcaption>${escapeHtml(video.alt)}</figcaption>` : '',
    '</figure>'
  ].filter(Boolean).join('\n');
}

function renderEmbedHtml(embed: BlueskyUpdateEmbed): string {
  if (embed.type === 'image') return imageHtml(embed);
  if (embed.type === 'external') return externalHtml(embed);
  if (embed.type === 'video') return videoHtml(embed);
  return quoteHtml(embed);
}

function quoteHtml(quote: BlueskyUpdateQuote): string {
  const author = quote.author?.displayName || quote.author?.handle || 'Bluesky post';
  const rkey = quote.uri.split('/').at(-1) ?? quote.uri;
  const handle = quote.author?.handle;
  const url = handle ? `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}` : '';
  const content = quote.text ? textHtml(quote.text) : '';
  const embedHtml = (quote.embeds ?? []).map(renderEmbedHtml).join('\n');
  const authorHtml = url
    ? `<strong><a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(author)}</a></strong>`
    : `<strong>${escapeHtml(author)}</strong>`;
  return [
    `<blockquote cite="${escapeHtml(url || quote.uri)}" class="lv-atproto-quote">`,
    `<p>${authorHtml}</p>`,
    content,
    embedHtml,
    '</blockquote>'
  ].filter(Boolean).join('\n');
}

async function withUploadedImages(
  config: SyncConfig,
  update: BlueskyUpdate,
  uploadImages: boolean
): Promise<BlueskyUpdateEmbed[]> {
  if (!uploadImages) return update.embeds;
  const embeds: BlueskyUpdateEmbed[] = [];
  let imageIndex = 0;
  let externalIndex = 0;
  let videoIndex = 0;

  async function uploadEmbed(embed: BlueskyUpdateEmbed): Promise<BlueskyUpdateEmbed> {
    if (embed.type === 'image') {
      const uploaded = await tryUploadGhostImageFromUrl(config, embed.url, imageFilename(update, imageIndex));
      imageIndex += 1;
      return { ...embed, url: uploaded ?? embed.url };
    }

    if (embed.type === 'external') {
      const externalImageUrl = isAnimatedGifExternal(embed) ? embed.uri : embed.thumb;
      if (!externalImageUrl) {
        return embed;
      }
      const uploaded = await tryUploadGhostImageFromUrl(config, externalImageUrl, externalImageFilename(update, externalIndex, externalImageUrl));
      externalIndex += 1;
      return { ...embed, thumb: uploaded ?? embed.thumb ?? (isAnimatedGifExternal(embed) ? embed.uri : undefined) };
    }

    if (embed.type === 'video') {
      if (!embed.thumbnail) {
        return embed;
      }
      const uploaded = await tryUploadGhostImageFromUrl(config, embed.thumbnail, videoPosterFilename(update, videoIndex));
      videoIndex += 1;
      return { ...embed, thumbnail: uploaded ?? embed.thumbnail };
    }

    if (embed.type === 'quote') {
      const quoteEmbeds = [];
      for (const nested of embed.embeds ?? []) {
        quoteEmbeds.push(await uploadEmbed(nested));
      }
      return { ...embed, embeds: quoteEmbeds };
    }

    return embed;
  }

  for (const embed of update.embeds) {
    embeds.push(await uploadEmbed(embed));
  }

  return embeds;
}

function postHtml(update: BlueskyUpdate, embeds: BlueskyUpdateEmbed[]): string {
  const embedHtml = embeds.map(renderEmbedHtml).join('\n');

  return [
    `<article class="lv-atproto-note" data-atproto-uri="${escapeHtml(update.uri)}"${update.cid ? ` data-atproto-cid="${escapeHtml(update.cid)}"` : ''}>`,
    textHtml(update.text),
    embedHtml,
    '</article>'
  ].filter(Boolean).join('\n');
}

export function ghostInputForBlueskyUpdate(
  update: BlueskyUpdate,
  embeds: BlueskyUpdateEmbed[] = update.embeds
) {
  return {
    slug: slugForUpdate(update),
    title: titleForUpdate(update),
    html: postHtml(update, embeds),
    custom_excerpt: null,
    feature_image: null,
    published_at: new Date(update.createdAt).toISOString(),
    tags: [{ name: 'updates' }, { name: '#bluesky' }, { name: '#atproto' }],
    status: 'published' as const
  };
}

export async function importBlueskyPosts(config: SyncConfig, options: ImportBlueskyPostsOptions = {}) {
  const limit = Math.max(1, Math.min(200, options.limit ?? 25));
  const updates = await readBlueskyUpdatesWindow(config, {
    limit,
    maxPages: options.maxPages ?? 10,
    since: options.since,
    until: options.until
  });
  const results = [];

  for (const update of updates.items) {
    const baseInput = ghostInputForBlueskyUpdate(update);
    const existing = await findGhostPostBySlug(config, baseInput.slug);

    if (options.dryRun) {
      results.push({
        action: existing ? 'would-update' : 'would-create',
        slug: baseInput.slug,
        title: baseInput.title,
        createdAt: update.createdAt,
        url: update.url,
        uri: update.uri,
        images: update.embeds.filter((embed) => embed.type === 'image').length
      });
      continue;
    }

    if (existing && !options.updateExisting) {
      results.push({ action: 'exists', slug: existing.slug, title: existing.title, url: existing.url, uri: update.uri });
      continue;
    }

    const embeds = await withUploadedImages(config, update, options.uploadImages !== false);
    const input = ghostInputForBlueskyUpdate(update, embeds);
    const post = existing
      ? await updateGhostHtmlEntry(config, existing, input)
      : await createGhostHtmlEntry(config, input);
    results.push({ action: existing ? 'updated' : 'created', slug: post.slug, title: post.title, url: post.url, uri: update.uri });
  }

  return {
    source: updates.source,
    fetchedAt: updates.fetchedAt,
    totalFetched: updates.items.length,
    processed: results.length,
    results
  };
}
