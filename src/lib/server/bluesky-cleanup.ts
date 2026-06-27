import type { SyncConfig } from './config.ts';
import { readGhostPostsByTag, updateGhostPostFields, type GhostPost } from './ghost.ts';

export interface CleanupBlueskyPostsOptions {
  dryRun?: boolean;
  limit?: number;
  page?: number;
}

const VISIBLE_ATPROTO_SOURCE_PATTERN = /\s*<span\s+aria-hidden=["']true["']>\s*·\s*<\/span>\s*<code>at:\/\/[^<]+<\/code>/g;
const VISIBLE_BLUESKY_SOURCE_PARAGRAPH_PATTERN = /\s*<p\s+class=["']lv-atproto-source["'][^>]*>[\s\S]*?<\/p>/g;

export function cleanBlueskyPostHtml(html: string | null | undefined): string {
  return String(html || '')
    .replace(VISIBLE_BLUESKY_SOURCE_PARAGRAPH_PATTERN, '')
    .replace(VISIBLE_ATPROTO_SOURCE_PATTERN, '');
}

function cleanupNeeded(post: GhostPost): boolean {
  return Boolean(post.feature_image || post.custom_excerpt || cleanBlueskyPostHtml(post.html) !== (post.html ?? ''));
}

export async function cleanupBlueskyPosts(config: SyncConfig, options: CleanupBlueskyPostsOptions = {}) {
  const limit = Math.max(1, Math.min(100, options.limit ?? 100));
  const page = Math.max(1, options.page ?? 1);
  const posts = await readGhostPostsByTag(config, '#bluesky', { limit, page, order: 'published_at desc' });
  const results = [];

  for (const post of posts) {
    const cleanedHtml = cleanBlueskyPostHtml(post.html);
    const needsCleanup = cleanupNeeded(post);
    if (options.dryRun) {
      results.push({
        action: needsCleanup ? 'would-clean' : 'unchanged',
        slug: post.slug,
        title: post.title,
        url: post.url,
        hadFeatureImage: Boolean(post.feature_image),
        hadCustomExcerpt: Boolean(post.custom_excerpt),
        removedVisibleSource: cleanedHtml !== (post.html ?? '')
      });
      continue;
    }

    if (!needsCleanup) {
      results.push({ action: 'unchanged', slug: post.slug, title: post.title, url: post.url });
      continue;
    }

    const updated = await updateGhostPostFields(config, post, {
      html: cleanedHtml,
      feature_image: null,
      custom_excerpt: null
    });
    results.push({ action: 'cleaned', slug: updated.slug, title: updated.title, url: updated.url });
  }

  return {
    page,
    limit,
    processed: posts.length,
    changed: results.filter((result) => result.action === 'cleaned' || result.action === 'would-clean').length,
    results
  };
}
