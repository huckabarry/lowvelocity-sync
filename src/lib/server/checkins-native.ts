import type { SyncConfig } from './config.ts';
import { createGhostHtmlEntry, findGhostPostBySlug, updateGhostHtmlEntry, uploadGhostImageFromUrl } from './ghost.ts';
import { readJsonResponse } from './http.ts';

const FOURSQUARE_API_BASE = 'https://api.foursquare.com/v2';
const FOURSQUARE_API_VERSION = '20260330';
const SWARM_MAX_PHOTOS = 6;

type SwarmVenueCategory = {
  id?: string;
  name?: string;
  shortName?: string;
  primary?: boolean;
};

type SwarmPhoto = {
  prefix?: string;
  suffix?: string;
  width?: number;
  height?: number;
  url?: string;
};

export type SwarmCheckin = {
  id?: string;
  createdAt?: number;
  timeZoneOffset?: number;
  isPrivate?: boolean;
  visibility?: string;
  shout?: string;
  venue?: {
    id?: string;
    name?: string;
    url?: string;
    location?: {
      address?: string;
      city?: string;
      state?: string;
      country?: string;
      lat?: number;
      lng?: number;
    };
    categories?: SwarmVenueCategory[];
  };
  photos?: {
    count?: number;
    items?: SwarmPhoto[];
  };
};

export interface ImportSwarmCheckinsOptions {
  dryRun?: boolean;
  limit?: number;
  offset?: number;
  maxPages?: number;
  since?: string;
  until?: string;
  updateExisting?: boolean;
  uploadImages?: boolean;
}

interface FoursquareCheckinsResponse {
  response?: {
    checkins?: {
      count?: number;
      items?: SwarmCheckin[];
    };
  };
}

function normalizeString(value: unknown): string {
  return String(value || '').trim();
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
  const paragraphs = normalizeString(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs
    .map((paragraph) => `<p>${linkifyEscapedText(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function slugify(value: string, fallback = 'checkin'): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/['".,!?()[\]{}:;]+/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function joinIfPresent(parts: Array<string | null | undefined>, separator = ', '): string {
  return parts.map((part) => normalizeString(part)).filter(Boolean).join(separator);
}

function visitedAt(checkin: SwarmCheckin): Date {
  const seconds = Number(checkin.createdAt || 0);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
  return new Date();
}

function visibility(checkin: SwarmCheckin): 'public' | 'private' {
  if (checkin.isPrivate) return 'private';
  const normalized = normalizeString(checkin.visibility).toLowerCase();
  return normalized === 'private' || normalized === 'off-grid' ? 'private' : 'public';
}

function pickVenueCategory(categories: unknown): string {
  if (!Array.isArray(categories)) return '';
  const normalized =
    categories.map((entry) => entry as SwarmVenueCategory).find((entry) => entry?.primary) ||
    (categories[0] as SwarmVenueCategory | undefined);
  return normalizeString(normalized?.shortName || normalized?.name);
}

function photoUrl(photo: SwarmPhoto): string {
  const direct = normalizeString(photo.url);
  if (direct) return direct;
  if (photo.prefix && photo.suffix) return `${photo.prefix}original${photo.suffix}`;
  return '';
}

function rawPhotoUrls(checkin: SwarmCheckin, includePhotos = true): string[] {
  if (!includePhotos || !Array.isArray(checkin.photos?.items)) return [];
  return checkin.photos.items.map(photoUrl).filter(Boolean).slice(0, SWARM_MAX_PHOTOS);
}

function checkinSourceId(checkin: SwarmCheckin): string {
  const id = normalizeString(checkin.id);
  if (!id) throw new Error('Swarm check-in is missing an id');
  return id;
}

function slugForCheckin(checkin: SwarmCheckin): string {
  const sourceId = checkinSourceId(checkin).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const venueName = normalizeString(checkin.venue?.name) || 'place';
  return `checkin-${slugify(venueName)}-${sourceId}`.slice(0, 180).replace(/-+$/g, '');
}

function titleForCheckin(checkin: SwarmCheckin): string {
  const name = normalizeString(checkin.venue?.name) || 'Untitled place';
  return `Checked in at ${name}`;
}

function imageFilename(checkin: SwarmCheckin, index: number): string {
  return `${slugForCheckin(checkin)}-${index + 1}.jpg`;
}

function imageHtml(url: string, venueName: string): string {
  const alt = venueName ? `Photo from ${venueName}` : 'Check-in photo';
  return [
    '<figure class="kg-card kg-image-card lv-checkin-image">',
    `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`,
    '</figure>'
  ].join('\n');
}

function metaHtml(label: string, value: string): string {
  return `<li><span>${escapeHtml(label)}</span> ${escapeHtml(value)}</li>`;
}

function mapsUrl(checkin: SwarmCheckin): string {
  const location = checkin.venue?.location;
  if (typeof location?.lat === 'number' && typeof location.lng === 'number') {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.lat},${location.lng}`)}`;
  }
  const query = joinIfPresent([checkin.venue?.name, location?.address, location?.city, location?.state, location?.country]);
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '';
}

function venueUrl(checkin: SwarmCheckin): string {
  const direct = normalizeString(checkin.venue?.url);
  if (direct) return direct;
  const venueId = normalizeString(checkin.venue?.id);
  return venueId ? `https://foursquare.com/v/${encodeURIComponent(venueId)}` : '';
}

async function fetchFoursquareJson<T>(path: string, accessToken: string, params = new URLSearchParams()): Promise<T> {
  const url = new URL(`${FOURSQUARE_API_BASE}${path}`);
  url.searchParams.set('v', FOURSQUARE_API_VERSION);
  url.searchParams.set('oauth_token', accessToken);
  for (const [key, value] of params) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });

  return readJsonResponse<T>(response, 'Foursquare API');
}

async function readSwarmCheckinsWindow(config: SyncConfig, options: ImportSwarmCheckinsOptions) {
  const accessToken = config.foursquareAccessToken;
  if (!accessToken) {
    throw new Error('Set FOURSQUARE_ACCESS_TOKEN or SWARM_ACCESS_TOKEN before importing check-ins');
  }

  const limit = clamp(options.limit, 25, 1, 250);
  const offset = clamp(options.offset, 0, 0, 100000);
  const maxPages = clamp(options.maxPages, 5, 1, 50);
  const pageSize = Math.min(100, Math.max(1, limit));
  const since = options.since ? Date.parse(options.since) : null;
  const until = options.until ? Date.parse(options.until) : null;
  const items: SwarmCheckin[] = [];
  let rawSeen = 0;
  let pagesScanned = 0;
  let reachedSinceBoundary = false;

  for (let page = 0; page < maxPages && items.length < limit && !reachedSinceBoundary; page += 1) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset + rawSeen)
    });
    const payload = await fetchFoursquareJson<FoursquareCheckinsResponse>('/users/self/checkins', accessToken, params);
    const pageItems = Array.isArray(payload.response?.checkins?.items) ? payload.response?.checkins?.items || [] : [];
    pagesScanned += 1;
    rawSeen += pageItems.length;
    if (!pageItems.length) break;

    for (const checkin of pageItems) {
      const visited = visitedAt(checkin).getTime();
      if (since !== null && Number.isFinite(since) && visited < since) {
        reachedSinceBoundary = true;
        continue;
      }
      if (until !== null && Number.isFinite(until) && visited > until) continue;
      items.push(checkin);
      if (items.length >= limit) break;
    }

    if (pageItems.length < pageSize) break;
  }

  return {
    source: 'foursquare',
    fetchedAt: new Date().toISOString(),
    offset,
    nextOffset: rawSeen > 0 && !reachedSinceBoundary ? offset + rawSeen : null,
    pagesScanned,
    items
  };
}

async function withUploadedImages(
  config: SyncConfig,
  checkin: SwarmCheckin,
  uploadImages: boolean
): Promise<string[]> {
  const urls = rawPhotoUrls(checkin);
  if (!uploadImages) return urls;
  const uploaded: string[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const ghostUrl = await uploadGhostImageFromUrl(config, url, imageFilename(checkin, index));
    uploaded.push(ghostUrl ?? url);
  }
  return uploaded;
}

function postHtml(checkin: SwarmCheckin, photoUrls: string[]): string {
  const sourceId = checkinSourceId(checkin);
  const venue = checkin.venue || {};
  const location = venue.location || {};
  const venueName = normalizeString(venue.name) || 'Untitled place';
  const region = joinIfPresent([location.city, location.state]);
  const place = joinIfPresent([region, location.country]);
  const category = pickVenueCategory(venue.categories);
  const address = joinIfPresent([location.address, region, location.country]);
  const map = mapsUrl(checkin);
  const venueHref = venueUrl(checkin);
  const latitude = typeof location.lat === 'number' && Number.isFinite(location.lat) ? location.lat : null;
  const longitude = typeof location.lng === 'number' && Number.isFinite(location.lng) ? location.lng : null;
  const venueId = normalizeString(venue.id);
  const visited = visitedAt(checkin).toISOString();
  const photosHtml = photoUrls.map((url) => imageHtml(url, venueName)).join('\n');
  const metadata = [
    category ? metaHtml('Category', category) : '',
    address ? metaHtml('Place', address) : '',
    metaHtml('Visited', visited.slice(0, 10))
  ].filter(Boolean).join('\n');
  const links = [
    map ? `<a href="${escapeHtml(map)}" rel="noopener">Map</a>` : '',
    venueHref ? `<a href="${escapeHtml(venueHref)}" rel="noopener">Venue</a>` : ''
  ].filter(Boolean).join(' · ');
  const attrs = [
    'class="lv-checkin"',
    'data-checkin-source="swarm"',
    `data-checkin-id="${escapeHtml(sourceId)}"`,
    `data-visited-at="${escapeHtml(visited)}"`,
    venueId ? `data-foursquare-venue-id="${escapeHtml(venueId)}"` : '',
    latitude !== null ? `data-lat="${latitude.toFixed(6)}"` : '',
    longitude !== null ? `data-lng="${longitude.toFixed(6)}"` : '',
    category ? `data-category="${escapeHtml(category)}"` : '',
    place ? `data-place="${escapeHtml(place)}"` : ''
  ].filter(Boolean).join(' ');

  return [
    `<article ${attrs}>`,
    normalizeString(checkin.shout) ? textHtml(normalizeString(checkin.shout)) : '',
    photosHtml,
    '<section class="lv-checkin-place">',
    `<h2>${escapeHtml(venueName)}</h2>`,
    place ? `<p>${escapeHtml(place)}</p>` : '',
    metadata ? `<ul>${metadata}</ul>` : '',
    links ? `<p class="lv-checkin-links">${links}</p>` : '',
    '</section>',
    '</article>'
  ].filter(Boolean).join('\n');
}

export function ghostInputForSwarmCheckin(checkin: SwarmCheckin, photos: string[] = rawPhotoUrls(checkin)) {
  const note = normalizeString(checkin.shout);
  const venueName = normalizeString(checkin.venue?.name) || 'Untitled place';
  const location = checkin.venue?.location || {};
  const place = joinIfPresent([location.city, location.state]);
  return {
    slug: slugForCheckin(checkin),
    title: titleForCheckin(checkin),
    html: postHtml(checkin, photos),
    custom_excerpt: note || joinIfPresent([venueName, place], ' · ') || null,
    feature_image: null,
    published_at: visitedAt(checkin).toISOString(),
    tags: [{ name: 'check-ins' }, { name: '#swarm' }, { name: '#foursquare' }],
    status: 'published' as const
  };
}

export async function importSwarmCheckins(config: SyncConfig, options: ImportSwarmCheckinsOptions = {}) {
  const updates = await readSwarmCheckinsWindow(config, options);
  const results = [];

  for (const checkin of updates.items) {
    const sourceId = normalizeString(checkin.id) || 'unknown';

    if (visibility(checkin) === 'private') {
      results.push({ action: 'skipped-private', sourceId });
      continue;
    }

    const baseInput = ghostInputForSwarmCheckin(checkin);
    const existing = await findGhostPostBySlug(config, baseInput.slug);

    if (options.dryRun) {
      results.push({
        action: existing ? 'would-update' : 'would-create',
        slug: baseInput.slug,
        title: baseInput.title,
        visitedAt: baseInput.published_at,
        sourceId,
        images: rawPhotoUrls(checkin).length
      });
      continue;
    }

    if (existing && !options.updateExisting) {
      results.push({ action: 'exists', slug: existing.slug, title: existing.title, url: existing.url, sourceId });
      continue;
    }

    const photos = await withUploadedImages(config, checkin, options.uploadImages !== false);
    const input = ghostInputForSwarmCheckin(checkin, photos);
    const post = existing
      ? await updateGhostHtmlEntry(config, existing, input)
      : await createGhostHtmlEntry(config, input);
    results.push({ action: existing ? 'updated' : 'created', slug: post.slug, title: post.title, url: post.url, sourceId });
  }

  return {
    source: updates.source,
    fetchedAt: updates.fetchedAt,
    offset: updates.offset,
    nextOffset: updates.nextOffset,
    pagesScanned: updates.pagesScanned,
    totalFetched: updates.items.length,
    processed: results.length,
    results
  };
}
