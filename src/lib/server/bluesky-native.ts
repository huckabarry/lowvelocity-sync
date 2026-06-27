import {
  blueskyPostRkey,
  readBlueskyUpdatesWindow,
  type BlueskyUpdate,
  type BlueskyUpdateEmbed,
  type BlueskyUpdateExternal,
  type BlueskyUpdateImage,
  type BlueskyUpdateQuote
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
  return [
    `<a class="lv-atproto-card" href="${escapeHtml(external.uri)}" rel="noopener">`,
    external.thumb ? `<img src="${escapeHtml(external.thumb)}" alt="" loading="lazy">` : '',
    '<span>',
    external.title ? `<strong>${escapeHtml(external.title)}</strong>` : escapeHtml(external.uri),
    external.description ? `<small>${escapeHtml(external.description)}</small>` : '',
    '</span>',
    '</a>'
  ].join('\n');
}

function quoteHtml(quote: BlueskyUpdateQuote): string {
  const author = quote.author?.displayName || quote.author?.handle || 'Bluesky post';
  const rkey = quote.uri.split('/').at(-1) ?? quote.uri;
  const handle = quote.author?.handle;
  const url = handle ? `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}` : '';
  const content = quote.text ? textHtml(quote.text) : '';
  return [
    `<blockquote class="lv-atproto-quote" cite="${escapeHtml(url || quote.uri)}">`,
    `<p><strong>${escapeHtml(author)}</strong></p>`,
    content,
    url ? `<p><a href="${escapeHtml(url)}" rel="noopener">View quoted post</a></p>` : '',
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

  for (const embed of update.embeds) {
    if (embed.type !== 'image') {
      embeds.push(embed);
      continue;
    }
    const uploaded = await uploadGhostImageFromUrl(config, embed.url, imageFilename(update, imageIndex));
    embeds.push({ ...embed, url: uploaded ?? embed.url });
    imageIndex += 1;
  }

  return embeds;
}

function postHtml(update: BlueskyUpdate, embeds: BlueskyUpdateEmbed[]): string {
  const embedHtml = embeds.map((embed) => {
    if (embed.type === 'image') return imageHtml(embed);
    if (embed.type === 'external') return externalHtml(embed);
    return quoteHtml(embed);
  }).join('\n');

  return [
    `<article class="lv-atproto-note" data-atproto-uri="${escapeHtml(update.uri)}"${update.cid ? ` data-atproto-cid="${escapeHtml(update.cid)}"` : ''}>`,
    textHtml(update.text),
    embedHtml,
    '<p class="lv-atproto-source">',
    `<a href="${escapeHtml(update.url)}" rel="syndication external noopener">View on Bluesky</a>`,
    '</p>',
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
