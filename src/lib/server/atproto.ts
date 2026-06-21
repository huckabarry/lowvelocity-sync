import { readJsonResponse, UpstreamError } from './http.ts';
import type { SyncConfig } from './config.ts';
import { DOCUMENT_COLLECTION, type StandardDocument } from './transform.ts';

interface SessionResponse { did?: string; accessJwt?: string; }
interface RecordResponse { uri?: string; cid?: string; }
interface GetRecordResponse { uri?: string; cid?: string; value?: Record<string, unknown>; }
interface ListedRecord { uri?: string; value?: Record<string, unknown>; }
interface ListRecordsResponse { records?: ListedRecord[]; cursor?: string; }

async function createSession(config: SyncConfig): Promise<{ did: string; accessJwt: string }> {
  const response = await fetch(`${config.atprotoService}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifier: config.atprotoIdentifier, password: config.atprotoAppPassword })
  });
  const session = await readJsonResponse<SessionResponse>(response, 'AT Protocol PDS');
  if (!session.did || !session.accessJwt) throw new Error('PDS session response was incomplete');
  if (session.did !== config.atprotoDid) throw new Error('PDS authenticated as the wrong DID');
  return { did: session.did, accessJwt: session.accessJwt };
}

export interface PutDocumentResult { uri: string; cid: string; }

async function getDocumentByRkey(
  config: SyncConfig,
  accessJwt: string,
  rkey: string
): Promise<{ rkey: string; value: Record<string, unknown> } | null> {
  const url = new URL(`${config.atprotoService}/xrpc/com.atproto.repo.getRecord`);
  url.searchParams.set('repo', config.atprotoDid);
  url.searchParams.set('collection', DOCUMENT_COLLECTION);
  url.searchParams.set('rkey', rkey);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessJwt}`, Accept: 'application/json' } });
  try {
    const result = await readJsonResponse<GetRecordResponse>(response, 'AT Protocol PDS');
    return result.value ? { rkey, value: result.value } : null;
  } catch (error) {
    if (error instanceof UpstreamError && error.code === 'RecordNotFound') return null;
    throw error;
  }
}

async function findDocumentByPath(
  config: SyncConfig,
  accessJwt: string,
  path: string
): Promise<{ rkey: string; value: Record<string, unknown> } | null> {
  const normalizePath = (value: string) => value === '/' ? value : value.replace(/\/+$/, '');
  const matches: { rkey: string; value: Record<string, unknown> }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${config.atprotoService}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set('repo', config.atprotoDid);
    url.searchParams.set('collection', DOCUMENT_COLLECTION);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessJwt}`, Accept: 'application/json' } });
    const result = await readJsonResponse<ListRecordsResponse>(response, 'AT Protocol PDS');
    for (const listed of result.records ?? []) {
      if (typeof listed.value?.path === 'string' && normalizePath(listed.value.path) === normalizePath(path) && listed.uri) {
        const rkey = listed.uri.split('/').pop();
        if (rkey) matches.push({ rkey, value: listed.value });
      }
    }
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  return matches.sort((a, b) => {
    const score = (match: typeof a) => Number(Boolean(match.value.content)) * 2 + Number(Boolean(match.value.coverImage));
    return score(b) - score(a);
  })[0] ?? null;
}

export async function putDocument(config: SyncConfig, rkey: string, record: StandardDocument): Promise<PutDocumentResult> {
  const session = await createSession(config);
  const existing = await getDocumentByRkey(config, session.accessJwt, rkey)
    ?? await findDocumentByPath(config, session.accessJwt, record.path);
  const resolvedRkey = existing?.rkey ?? rkey;
  const resolvedRecord = existing ? { ...existing.value, ...record } : record;
  const response = await fetch(`${config.atprotoService}/xrpc/com.atproto.repo.putRecord`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ repo: session.did, collection: DOCUMENT_COLLECTION, rkey: resolvedRkey, record: resolvedRecord })
  });
  const result = await readJsonResponse<RecordResponse>(response, 'AT Protocol PDS');
  if (!result.uri || !result.cid) throw new Error('PDS record response was incomplete');
  return { uri: result.uri, cid: result.cid };
}

async function deleteDocumentByRkey(config: SyncConfig, accessJwt: string, did: string, rkey: string): Promise<boolean> {
  const response = await fetch(`${config.atprotoService}/xrpc/com.atproto.repo.deleteRecord`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ repo: did, collection: DOCUMENT_COLLECTION, rkey })
  });
  try {
    await readJsonResponse<Record<string, never>>(response, 'AT Protocol PDS');
    return true;
  } catch (error) {
    if (error instanceof UpstreamError && error.code === 'RecordNotFound') return false;
    throw error;
  }
}

export async function deleteDocument(config: SyncConfig, rkey: string, path?: string): Promise<boolean> {
  const session = await createSession(config);
  if (await deleteDocumentByRkey(config, session.accessJwt, session.did, rkey)) return true;
  const existing = path ? await findDocumentByPath(config, session.accessJwt, path) : null;
  if (!existing || existing.rkey === rkey) return false;
  return deleteDocumentByRkey(config, session.accessJwt, session.did, existing.rkey);
}
