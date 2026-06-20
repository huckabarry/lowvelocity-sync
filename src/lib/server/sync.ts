import { deleteDocument, putDocument } from './atproto.ts';
import type { SyncConfig } from './config.ts';
import { readGhostPost, setDocumentLink } from './ghost.ts';
import { ghostPostToDocument } from './transform.ts';

export async function syncPublishedPost(config: SyncConfig, postId: string) {
  const post = await readGhostPost(config, postId);
  if (post.status !== 'published') throw new Error(`Refusing to sync Ghost post with status ${post.status}`);
  const result = await putDocument(config, post.id, ghostPostToDocument(post, config.publicationUri));
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
  return { action: 'delete' as const, postId, deleted: await deleteDocument(config, postId, path) };
}
