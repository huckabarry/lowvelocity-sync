import { deleteDocument, putDocument } from './atproto.ts';
import type { SyncConfig } from './config.ts';
import { existingDocumentRkey } from './document-identity.ts';
import { readGhostPost, setDocumentLink } from './ghost.ts';
import { ghostPostToDocument } from './transform.ts';

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
