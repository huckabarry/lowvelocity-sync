import { deleteDocument, putDocument } from './atproto.ts';
import type { SyncConfig } from './config.ts';
import { existingDocumentRkey } from './document-identity.ts';
import { readGhostPost, setDocumentLink } from './ghost.ts';
import { ghostPostToDocument } from './transform.ts';

const STANDARD_SITE_EXCLUDED_TAGS = new Set([
  '#crucialtracks',
  '#bluesky',
  '#atproto',
  '#swarm',
  '#foursquare',
  '#popfeed',
  '#pds'
]);

function standardSiteExclusionReason(tags: Array<{ name?: string }> | undefined): string | null {
  const names = tags?.map((tag) => tag.name).filter(Boolean) ?? [];
  if (names.some((name) => STANDARD_SITE_EXCLUDED_TAGS.has(name ?? ''))) {
    return 'internally syndicated posts are excluded from standard.site sync';
  }
  return null;
}

export async function syncPublishedPost(config: SyncConfig, postId: string) {
  if (!config.standardSiteSyncEnabled) {
    return {
      action: 'skip' as const,
      reason: 'standard.site sync disabled' as const,
      postId
    };
  }

  const post = await readGhostPost(config, postId);
  if (post.status !== 'published') throw new Error(`Refusing to sync Ghost post with status ${post.status}`);
  const exclusionReason = standardSiteExclusionReason(post.tags);
  if (exclusionReason) {
    return {
      action: 'skip' as const,
      reason: exclusionReason,
      postId: post.id,
      slug: post.slug
    };
  }

  const rkey = existingDocumentRkey(post) ?? post.id;
  const result = await putDocument(config, rkey, ghostPostToDocument(post, config.publicationUri));
  return {
    action: 'sync' as const,
    postId: post.id,
    slug: post.slug,
    uri: result.uri,
    cid: result.cid,
    verificationUpdated: await setDocumentLink(config, post, result.uri)
  };
}

export async function removePublishedPost(config: SyncConfig, postId: string, path?: string) {
  if (!config.standardSiteSyncEnabled) {
    return {
      action: 'skip-delete' as const,
      reason: 'standard.site sync disabled' as const,
      postId
    };
  }

  return { action: 'delete' as const, postId, deleted: await deleteDocument(config, postId, path) };
}
