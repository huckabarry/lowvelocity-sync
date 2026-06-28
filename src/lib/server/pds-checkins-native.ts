import type { SyncConfig } from './config.ts';
import {
  createGhostHtmlEntry,
  findGhostPostBySlug,
  updateGhostHtmlEntry,
  uploadGhostImageFromUrl
} from './ghost.ts';
import { readJsonResponse } from './http.ts';
import { ghostInputForSwarmCheckin, type SwarmCheckin } from './checkins-native.ts';

const CHECKIN_COLLECTION = 'blog.afterword.checkin';

interface PdsDidDocument {
  service?: Array<{
    id?: string;
    type?: string;
    serviceEndpoint?: string;
  }>;
}

interface PdsRecord<T> {
  uri: string;
  cid?: string;
  value: T;
}

interface PdsListRecordsResponse<T> {
  cursor?: string;
  records?: Array<PdsRecord<T>>;
}

interface PdsBlobRef {
  ref?: {
    $link?: string;
  };
  mimeType?: string;
}

interface PdsCheckinRecord {
  $type?: string;
  name?: string;
  note?: string;
  excerpt?: string;
  slug?: string;
  source?: string;
  sourceId?: string;
  visibility?: string;
  visitedAt?: string;
  createdAt?: string;
  timezone?: string;
  website?: string;
  address?: string;
  locality?: string;
  region?: string;
  country?: string;
  latitude?: string | number;
  longitude?: string | number;
  venueCategory?: string;
  foursquareVenueId?: string;
  photo?: PdsBlobRef;
  photos?: PdsBlobRef[];
}

export interface ImportPdsCheckinsOptions {
  dryRun?: boolean;
  limit?: number;
  maxPages?: number;
  since?: string;
  until?: string;
  updateExisting?: boolean;
  uploadImages?: boolean;
  repo?: string;
}

function normalizeString(value: unknown): string {
  return String(value || '').trim();
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function atUriRkey(uri: string): string {
  const parts = String(uri || '').split('/');
  return normalizeString(parts[parts.length - 1]) || 'unknown';
}

function dateValue(record: PdsCheckinRecord): Date {
  const parsed = Date.parse(record.visitedAt || record.createdAt || '');
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function regionParts(record: PdsCheckinRecord): { city?: string; state?: string } {
  const locality = normalizeString(record.locality);
  const region = normalizeString(record.region);
  if (!region) return { city: locality || undefined };
  const parts = region.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: locality || parts[0], state: parts.slice(1).join(', ') };
  return { city: locality || region };
}

function numberValue(value: string | number | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function blobCid(blob: PdsBlobRef | undefined): string {
  return normalizeString(blob?.ref?.$link);
}

function pdsBlobUrl(pdsEndpoint: string, repo: string, cid: string): string {
  const url = new URL('/xrpc/com.atproto.sync.getBlob', pdsEndpoint);
  url.searchParams.set('did', repo);
  url.searchParams.set('cid', cid);
  return url.toString();
}

function photoUrls(record: PdsCheckinRecord, pdsEndpoint: string, repo: string): string[] {
  const seen = new Set<string>();
  const blobs = [record.photo, ...(Array.isArray(record.photos) ? record.photos : [])];
  const urls: string[] = [];
  for (const blob of blobs) {
    const cid = blobCid(blob);
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    urls.push(pdsBlobUrl(pdsEndpoint, repo, cid));
  }
  return urls;
}

function imageFilename(checkin: SwarmCheckin, index: number): string {
  const sourceId = normalizeString(checkin.id).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'pds';
  return `checkin-${sourceId}-${index + 1}.jpg`;
}

function pdsRecordToSwarmCheckin(record: PdsRecord<PdsCheckinRecord>): SwarmCheckin {
  const value = record.value;
  const rkey = atUriRkey(record.uri);
  const sourceId = normalizeString(value.sourceId) || rkey;
  const visited = dateValue(value);
  const { city, state } = regionParts(value);
  const category = normalizeString(value.venueCategory);

  return {
    id: sourceId,
    createdAt: Math.floor(visited.getTime() / 1000),
    visibility: normalizeString(value.visibility) || 'public',
    isPrivate: normalizeString(value.visibility).toLowerCase() === 'private',
    shout: normalizeString(value.note || value.excerpt),
    venue: {
      id: normalizeString(value.foursquareVenueId) || undefined,
      name: normalizeString(value.name) || 'Untitled place',
      url: normalizeString(value.website) || undefined,
      location: {
        address: normalizeString(value.address) || undefined,
        city,
        state,
        country: normalizeString(value.country) || undefined,
        lat: numberValue(value.latitude),
        lng: numberValue(value.longitude)
      },
      categories: category ? [{ name: category, shortName: category, primary: true }] : []
    },
    photos: {
      items: []
    }
  };
}

async function resolvePdsEndpoint(repo: string): Promise<string> {
  const didUrl = new URL(`/${encodeURIComponent(repo)}`, 'https://plc.directory');
  const response = await fetch(didUrl);
  const body = await readJsonResponse<PdsDidDocument>(response, 'DID PLC directory');
  const service = body.service?.find((entry) => entry.id === '#atproto_pds') || body.service?.[0];
  const endpoint = normalizeString(service?.serviceEndpoint).replace(/\/$/, '');
  if (!endpoint) throw new Error(`Unable to resolve PDS endpoint for ${repo}`);
  return endpoint;
}

async function readPdsCheckinsWindow(config: SyncConfig, options: ImportPdsCheckinsOptions) {
  const repo = normalizeString(options.repo) || config.blueskyUpdatesDid;
  const pdsEndpoint = await resolvePdsEndpoint(repo);
  const limit = clamp(options.limit, 100, 1, 1000);
  const maxPages = clamp(options.maxPages, 20, 1, 100);
  const since = options.since ? Date.parse(options.since) : null;
  const until = options.until ? Date.parse(options.until) : null;
  const records: Array<PdsRecord<PdsCheckinRecord>> = [];
  let cursor = '';
  let pagesScanned = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL('/xrpc/com.atproto.repo.listRecords', pdsEndpoint);
    url.searchParams.set('repo', repo);
    url.searchParams.set('collection', CHECKIN_COLLECTION);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url);
    const payload = await readJsonResponse<PdsListRecordsResponse<PdsCheckinRecord>>(response, 'PDS check-in records');
    pagesScanned += 1;

    for (const record of payload.records || []) {
      const visited = dateValue(record.value).getTime();
      if (since !== null && Number.isFinite(since) && visited < since) continue;
      if (until !== null && Number.isFinite(until) && visited > until) continue;
      if (normalizeString(record.value.visibility).toLowerCase() === 'private') continue;
      records.push(record);
    }

    cursor = payload.cursor || '';
    if (!cursor) break;
  }

  records.sort((a, b) => dateValue(b.value).getTime() - dateValue(a.value).getTime());

  return {
    source: 'pds-checkins',
    repo,
    pdsEndpoint,
    fetchedAt: new Date().toISOString(),
    pagesScanned,
    items: records.slice(0, limit)
  };
}

async function withUploadedImages(
  config: SyncConfig,
  checkin: SwarmCheckin,
  urls: string[],
  uploadImages: boolean
): Promise<string[]> {
  if (!uploadImages) return urls;
  const uploaded: string[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const ghostUrl = await uploadGhostImageFromUrl(config, url, imageFilename(checkin, index));
    uploaded.push(ghostUrl ?? url);
  }
  return uploaded;
}

export async function importPdsCheckins(config: SyncConfig, options: ImportPdsCheckinsOptions = {}) {
  const updates = await readPdsCheckinsWindow(config, options);
  const results = [];

  for (const record of updates.items) {
    const checkin = pdsRecordToSwarmCheckin(record);
    const sourceId = normalizeString(checkin.id) || atUriRkey(record.uri);
    const baseInput = ghostInputForSwarmCheckin(checkin);
    const existing = await findGhostPostBySlug(config, baseInput.slug);
    const urls = photoUrls(record.value, updates.pdsEndpoint, updates.repo);

    if (options.dryRun) {
      results.push({
        action: existing ? 'would-update' : 'would-create',
        slug: baseInput.slug,
        title: baseInput.title,
        visitedAt: baseInput.published_at,
        sourceId,
        uri: record.uri,
        images: urls.length
      });
      continue;
    }

    if (existing && !options.updateExisting) {
      results.push({ action: 'exists', slug: existing.slug, title: existing.title, url: existing.url, sourceId, uri: record.uri });
      continue;
    }

    const photos = await withUploadedImages(config, checkin, urls, options.uploadImages !== false);
    const input = ghostInputForSwarmCheckin(checkin, photos);
    const post = existing
      ? await updateGhostHtmlEntry(config, existing, input)
      : await createGhostHtmlEntry(config, input);
    results.push({ action: existing ? 'updated' : 'created', slug: post.slug, title: post.title, url: post.url, sourceId, uri: record.uri });
  }

  return {
    source: updates.source,
    repo: updates.repo,
    pdsEndpoint: updates.pdsEndpoint,
    fetchedAt: updates.fetchedAt,
    pagesScanned: updates.pagesScanned,
    totalFetched: updates.items.length,
    processed: results.length,
    results
  };
}
