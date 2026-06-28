import type { SyncConfig } from './config.ts';
import {
  createGhostHtmlEntry,
  findGhostPostBySlug,
  updateGhostHtmlEntry,
  uploadGhostImageFromUrl
} from './ghost.ts';
import { readJsonResponse } from './http.ts';

const POPFEED_ITEM_COLLECTION = 'blog.afterword.media.popfeedItem';
const POPFEED_OVERRIDE_COLLECTION = 'blog.afterword.media.popfeedOverride';

type PopfeedType = 'book' | 'movie' | 'tv_show' | string;

interface PdsBlobRef {
  ref?: {
    $link?: string;
  };
  mimeType?: string;
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

interface PopfeedCanonicalRecord {
  $type?: string;
  sourceUri?: string;
  sourceCollection?: string;
  sourceCid?: string;
  title?: string;
  creativeWorkType?: PopfeedType;
  mainCredit?: string;
  mainCreditRole?: string;
  genres?: string[];
  listUri?: string;
  listName?: string;
  listType?: string;
  identifiers?: Record<string, string>;
  addedAt?: string;
  startedAt?: string;
  completedAt?: string;
  activityAt?: string;
  releaseDate?: string;
  posterImage?: string;
  sourcePosterImage?: string;
  backdropUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface PopfeedOverrideRecord {
  sourceUri?: string;
  creativeWorkType?: string;
  title?: string;
  status?: 'approved' | 'pending' | 'hidden' | string;
  image?: {
    image?: PdsBlobRef;
    alt?: string;
    originalUrl?: string;
    provider?: string;
  };
  provenance?: {
    syncedAt?: string;
    sourceImageUrl?: string;
  };
}

export interface ImportPopfeedOptions {
  dryRun?: boolean;
  limit?: number;
  maxPages?: number;
  since?: string;
  until?: string;
  updateExisting?: boolean;
  uploadImages?: boolean;
  repo?: string;
  pdsEndpoint?: string;
  includeCurrentlyReading?: boolean;
}

export interface PopfeedImportItem {
  uri: string;
  cid?: string;
  sourceUri: string;
  sourceRkey: string;
  type: PopfeedType;
  title: string;
  mainCredit: string;
  mainCreditRole: string;
  genres: string[];
  listType: string;
  listName: string;
  identifiers: Record<string, string>;
  activityLabel: string;
  activityAt: string;
  posterImage: string | null;
  sourcePosterImage: string | null;
  overrideStatus: string | null;
  links: Array<{ label: string; url: string }>;
}

function normalizeString(value: unknown): string {
  return String(value || '').trim();
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(value: string, fallback = 'media'): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/['".,!?()[\]{}:;]+/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function atUriRkey(uri: string): string {
  const parts = String(uri || '').split('/');
  return normalizeString(parts[parts.length - 1]) || 'unknown';
}

function normalizeDate(value: unknown): string | null {
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dateForRecord(record: PopfeedCanonicalRecord): string {
  return normalizeDate(record.activityAt)
    || normalizeDate(record.completedAt)
    || normalizeDate(record.startedAt)
    || normalizeDate(record.addedAt)
    || normalizeDate(record.releaseDate)
    || new Date().toISOString();
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

function titleCase(value: string): string {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mediaNoun(type: PopfeedType): string {
  if (type === 'book') return 'Book';
  if (type === 'tv_show') return 'Show';
  if (type === 'movie') return 'Movie';
  return titleCase(type || 'Media');
}

function slugType(type: PopfeedType): string {
  if (type === 'tv_show') return 'show';
  return slugify(type || 'media');
}

function activityLabel(listType: string): string {
  switch (listType) {
    case 'read_books':
      return 'Finished reading';
    case 'currently_reading_books':
      return 'Started reading';
    case 'watched_movies':
    case 'watched_tv_shows':
      return 'Watched';
    case 'currently_watching_tv_shows':
      return 'Currently watching';
    default:
      return titleCase(listType || 'Logged');
  }
}

function shouldImport(record: PopfeedCanonicalRecord, includeCurrentlyReading = true): boolean {
  const listType = normalizeString(record.listType);
  if (listType === 'read_books' || listType === 'watched_movies' || listType === 'watched_tv_shows') return true;
  if (includeCurrentlyReading && (listType === 'currently_reading_books' || listType === 'currently_watching_tv_shows')) return true;
  return false;
}

function normalizeIdentifiers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const normalized = normalizeString(entry);
      return normalized ? [[key, normalized]] : [];
    })
  );
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(normalizeString).filter(Boolean) : [];
}

function popfeedLinks(type: PopfeedType, identifiers: Record<string, string>): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  if (type === 'book') {
    const isbn = identifiers.isbn13 || identifiers.isbn10;
    if (isbn) links.push({ label: 'Open Library', url: `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}` });
  }
  if (type === 'movie' || type === 'tv_show') {
    if (identifiers.tmdbId) {
      const kind = type === 'tv_show' ? 'tv' : 'movie';
      links.push({ label: 'TMDB', url: `https://www.themoviedb.org/${kind}/${encodeURIComponent(identifiers.tmdbId)}` });
    }
    if (identifiers.imdbId) links.push({ label: 'IMDb', url: `https://www.imdb.com/title/${encodeURIComponent(identifiers.imdbId)}/` });
  }
  return links;
}

async function listPdsRecords<T>(
  pdsEndpoint: string,
  repo: string,
  collection: string,
  maxPages: number
): Promise<Array<PdsRecord<T>>> {
  const records: Array<PdsRecord<T>> = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL('/xrpc/com.atproto.repo.listRecords', pdsEndpoint);
    url.searchParams.set('repo', repo);
    url.searchParams.set('collection', collection);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const payload = await readJsonResponse<PdsListRecordsResponse<T>>(response, `PDS ${collection} records`);
    records.push(...(payload.records || []));
    cursor = payload.cursor || '';
    if (!cursor) break;
  }
  return records;
}

function overrideImageUrl(record: PopfeedOverrideRecord, pdsEndpoint: string, repo: string): string | null {
  const cid = blobCid(record.image?.image);
  if (cid) return pdsBlobUrl(pdsEndpoint, repo, cid);
  return normalizeOptionalString(record.image?.originalUrl) || normalizeOptionalString(record.provenance?.sourceImageUrl);
}

function applyOverride(
  item: PopfeedImportItem,
  override: PdsRecord<PopfeedOverrideRecord> | undefined,
  pdsEndpoint: string,
  repo: string
): PopfeedImportItem {
  if (!override) return item;
  const status = normalizeString(override.value.status) || 'unknown';
  if (status === 'hidden') {
    return { ...item, posterImage: null, overrideStatus: status };
  }
  if (status !== 'approved') return { ...item, overrideStatus: status };
  return {
    ...item,
    posterImage: overrideImageUrl(override.value, pdsEndpoint, repo) || item.posterImage,
    overrideStatus: status
  };
}

function canonicalToItem(
  record: PdsRecord<PopfeedCanonicalRecord>,
  overridesBySourceUri: Map<string, PdsRecord<PopfeedOverrideRecord>>,
  pdsEndpoint: string,
  repo: string
): PopfeedImportItem | null {
  const value = record.value;
  const sourceUri = normalizeString(value.sourceUri);
  const title = normalizeString(value.title);
  const type = normalizeString(value.creativeWorkType) || 'media';
  if (!sourceUri || !title) return null;
  const identifiers = normalizeIdentifiers(value.identifiers);
  const base: PopfeedImportItem = {
    uri: record.uri,
    cid: record.cid,
    sourceUri,
    sourceRkey: atUriRkey(sourceUri),
    type,
    title,
    mainCredit: normalizeString(value.mainCredit),
    mainCreditRole: normalizeString(value.mainCreditRole),
    genres: normalizeStringArray(value.genres),
    listType: normalizeString(value.listType),
    listName: normalizeString(value.listName),
    identifiers,
    activityLabel: activityLabel(normalizeString(value.listType)),
    activityAt: dateForRecord(value),
    posterImage: normalizeOptionalString(value.posterImage) || normalizeOptionalString(value.sourcePosterImage),
    sourcePosterImage: normalizeOptionalString(value.sourcePosterImage),
    overrideStatus: null,
    links: popfeedLinks(type, identifiers)
  };
  return applyOverride(base, overridesBySourceUri.get(sourceUri), pdsEndpoint, repo);
}

function popfeedPostSlug(item: PopfeedImportItem): string {
  return `${slugType(item.type)}-${slugify(item.title)}-${slugify(item.sourceRkey, 'pds')}`.slice(0, 180).replace(/-+$/g, '');
}

function imageFilename(item: PopfeedImportItem): string {
  return `${popfeedPostSlug(item)}.jpg`;
}

function popfeedTags(item: PopfeedImportItem): Array<{ name: string }> {
  const tags = [{ name: '#popfeed' }, { name: '#pds' }];
  if (item.type === 'book') return [{ name: 'books' }, { name: 'reading' }, ...tags];
  if (item.type === 'tv_show') return [{ name: 'shows' }, { name: 'watching' }, ...tags];
  if (item.type === 'movie') return [{ name: 'movies' }, { name: 'watching' }, ...tags];
  return [{ name: 'media' }, ...tags];
}

function metadataLine(label: string, value: string): string {
  return `<li><span>${escapeHtml(label)}</span> ${escapeHtml(value)}</li>`;
}

function popfeedPostHtml(item: PopfeedImportItem): string {
  const credit = item.mainCredit
    ? `<p class="lv-popfeed-credit">${escapeHtml(item.mainCreditRole || 'By')} ${escapeHtml(item.mainCredit)}</p>`
    : '';
  const genres = item.genres.length ? metadataLine('Genres', item.genres.slice(0, 5).join(', ')) : '';
  const source = item.sourceUri ? metadataLine('Source', item.sourceUri) : '';
  const identifiers = Object.entries(item.identifiers)
    .slice(0, 4)
    .map(([key, value]) => metadataLine(key, value))
    .join('\n');
  const links = item.links
    .map((link) => `<a href="${escapeHtml(link.url)}" rel="noopener">${escapeHtml(link.label)}</a>`)
    .join(' · ');
  const attrs = [
    'class="lv-popfeed-entry"',
    `data-popfeed-uri="${escapeHtml(item.uri)}"`,
    `data-popfeed-source-uri="${escapeHtml(item.sourceUri)}"`,
    `data-popfeed-type="${escapeHtml(item.type)}"`,
    `data-popfeed-list-type="${escapeHtml(item.listType)}"`
  ].join(' ');

  return [
    `<article ${attrs}>`,
    `<p class="lv-popfeed-status">${escapeHtml(item.activityLabel)}</p>`,
    credit,
    '<section class="lv-popfeed-details">',
    `<h2>${escapeHtml(mediaNoun(item.type))}</h2>`,
    `<ul>${[genres, identifiers, source].filter(Boolean).join('\n')}</ul>`,
    links ? `<p class="lv-popfeed-links">${links}</p>` : '',
    '</section>',
    '</article>'
  ].filter(Boolean).join('\n');
}

function popfeedExcerpt(item: PopfeedImportItem): string {
  const parts = [
    `${item.activityLabel} ${item.title}`,
    item.mainCredit ? `${item.mainCreditRole || 'by'} ${item.mainCredit}` : '',
    item.genres.slice(0, 3).join(', ')
  ].filter(Boolean);
  return parts.join(' — ').slice(0, 300);
}

export function ghostInputForPopfeedItem(item: PopfeedImportItem, featureImage: string | null = item.posterImage) {
  return {
    slug: popfeedPostSlug(item),
    title: item.title,
    html: popfeedPostHtml(item),
    custom_excerpt: popfeedExcerpt(item),
    feature_image: featureImage,
    published_at: item.activityAt,
    tags: popfeedTags(item),
    status: 'published' as const
  };
}

export async function readCanonicalPopfeedItems(config: SyncConfig, options: ImportPopfeedOptions = {}) {
  const repo = normalizeString(options.repo) || config.mediaPdsDid;
  const pdsEndpoint = (normalizeString(options.pdsEndpoint) || config.mediaPdsService).replace(/\/$/, '');
  const maxPages = clamp(options.maxPages, 20, 1, 100);
  const since = options.since ? Date.parse(options.since) : null;
  const until = options.until ? Date.parse(options.until) : null;
  const includeCurrentlyReading = options.includeCurrentlyReading === true;

  const [canonicalRecords, overrideRecords] = await Promise.all([
    listPdsRecords<PopfeedCanonicalRecord>(pdsEndpoint, repo, POPFEED_ITEM_COLLECTION, maxPages),
    listPdsRecords<PopfeedOverrideRecord>(pdsEndpoint, repo, POPFEED_OVERRIDE_COLLECTION, maxPages)
  ]);
  const overridesBySourceUri = new Map(
    overrideRecords
      .filter((record) => normalizeString(record.value.sourceUri))
      .map((record) => [normalizeString(record.value.sourceUri), record])
  );

  const items = canonicalRecords
    .filter((record) => shouldImport(record.value, includeCurrentlyReading))
    .map((record) => canonicalToItem(record, overridesBySourceUri, pdsEndpoint, repo))
    .filter((item): item is PopfeedImportItem => Boolean(item))
    .filter((item) => {
      const activity = Date.parse(item.activityAt);
      if (since !== null && Number.isFinite(since) && activity < since) return false;
      if (until !== null && Number.isFinite(until) && activity > until) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt));

  return {
    source: 'pds-popfeed',
    repo,
    pdsEndpoint,
    fetchedAt: new Date().toISOString(),
    pagesScanned: maxPages,
    totalCanonical: canonicalRecords.length,
    totalOverrides: overrideRecords.length,
    items
  };
}

export async function importPopfeedMedia(config: SyncConfig, options: ImportPopfeedOptions = {}) {
  const updates = await readCanonicalPopfeedItems(config, options);
  const limit = clamp(options.limit, 50, 1, 500);
  const selected = updates.items.slice(0, limit);
  const results = [];

  for (const item of selected) {
    const baseInput = ghostInputForPopfeedItem(item);
    const existing = await findGhostPostBySlug(config, baseInput.slug);

    if (options.dryRun) {
      results.push({
        action: existing ? 'would-update' : 'would-create',
        slug: baseInput.slug,
        title: baseInput.title,
        type: item.type,
        listType: item.listType,
        activityAt: item.activityAt,
        sourceUri: item.sourceUri,
        image: Boolean(item.posterImage)
      });
      continue;
    }

    if (existing && !options.updateExisting) {
      results.push({ action: 'exists', slug: existing.slug, title: existing.title, url: existing.url, sourceUri: item.sourceUri });
      continue;
    }

    const image = existing?.feature_image
      || (item.posterImage && options.uploadImages !== false
        ? await uploadGhostImageFromUrl(config, item.posterImage, imageFilename(item))
        : item.posterImage);
    const input = ghostInputForPopfeedItem(item, image || null);
    const post = existing
      ? await updateGhostHtmlEntry(config, existing, input)
      : await createGhostHtmlEntry(config, input);
    results.push({ action: existing ? 'updated' : 'created', slug: post.slug, title: post.title, url: post.url, sourceUri: item.sourceUri });
  }

  return {
    source: updates.source,
    repo: updates.repo,
    pdsEndpoint: updates.pdsEndpoint,
    fetchedAt: updates.fetchedAt,
    totalCanonical: updates.totalCanonical,
    totalOverrides: updates.totalOverrides,
    totalImportable: updates.items.length,
    processed: results.length,
    limit,
    results
  };
}
