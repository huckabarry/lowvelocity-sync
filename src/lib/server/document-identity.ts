import type { GhostPost } from './ghost.ts';

const DOCUMENT_COLLECTION = 'site.standard.document';

function rkeyFromAtUri(value: string): string | null {
  const marker = `/${DOCUMENT_COLLECTION}/`;
  const markerIndex = value.indexOf(marker);
  if (!value.startsWith('at://') || markerIndex === -1) return null;
  const rkey = value.slice(markerIndex + marker.length).split(/[\s"'<>]/)[0];
  return rkey || null;
}

export function existingDocumentRkey(post: Pick<GhostPost, 'codeinjection_head' | 'codeinjection_foot'>): string | null {
  const existing = `${post.codeinjection_head ?? ''}\n${post.codeinjection_foot ?? ''}`;
  const relIndex = existing.indexOf('site.standard.document');
  if (relIndex === -1) return null;
  const atIndex = existing.lastIndexOf('at://', relIndex) === -1
    ? existing.indexOf('at://', relIndex)
    : existing.lastIndexOf('at://', relIndex);
  if (atIndex === -1) return null;
  return rkeyFromAtUri(existing.slice(atIndex));
}
