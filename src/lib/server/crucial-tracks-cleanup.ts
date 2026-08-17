import type { SyncConfig } from './config.ts';
import { crucialTrackIdentity, crucialTrackSlug, getCrucialTrackIdentityEntries } from './crucial-tracks.ts';
import { deleteGhostPost, readGhostPostsByTag, type GhostPost } from './ghost.ts';

function postIdentity(post: GhostPost): string {
  const separator = post.title.lastIndexOf(' — ');
  return crucialTrackIdentity(separator === -1 ? post.title : post.title.slice(0, separator), separator === -1 ? '' : post.title.slice(separator + 3), post.published_at);
}

export function duplicateCrucialTrackPosts(posts: GhostPost[], canonicalSlugs: Map<string, string>) {
  const groups = new Map<string, GhostPost[]>();
  for (const post of posts) {
    const identity = postIdentity(post);
    groups.set(identity, [...(groups.get(identity) ?? []), post]);
  }
  return [...groups.entries()].flatMap(([identity, group]) => {
    if (group.length < 2) return [];
    const canonicalSlug = canonicalSlugs.get(identity);
    const canonical = canonicalSlug ? group.find((post) => post.slug === canonicalSlug) : undefined;
    return canonical ? group.filter((post) => post.id !== canonical.id).map((duplicate) => ({ canonical, duplicate })) : [];
  });
}

export async function cleanupCrucialTrackDuplicates(config: SyncConfig, dryRun = true) {
  const entries = await getCrucialTrackIdentityEntries();
  const canonicalSlugs = new Map(entries.map((entry) => [crucialTrackIdentity(entry.title, entry.artist, entry.publishedAt), crucialTrackSlug(entry)]));
  const posts: GhostPost[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await readGhostPostsByTag(config, '#crucialtracks', { limit: 100, page, order: 'published_at desc' });
    posts.push(...batch);
    if (batch.length < 100) break;
  }
  const duplicates = duplicateCrucialTrackPosts(posts, canonicalSlugs);
  const results = [];
  for (const { canonical, duplicate } of duplicates) {
    if (!dryRun) await deleteGhostPost(config, duplicate);
    results.push({ action: dryRun ? 'would-delete' : 'deleted', title: duplicate.title, duplicateSlug: duplicate.slug, canonicalSlug: canonical.slug, duplicateUrl: duplicate.url, canonicalUrl: canonical.url });
  }
  return { processed: posts.length, duplicates: duplicates.length, results };
}
