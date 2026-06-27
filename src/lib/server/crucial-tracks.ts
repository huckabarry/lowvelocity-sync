import { createGhostHtmlEntry, findGhostPostBySlug, updateGhostHtmlEntry, uploadGhostImageFromUrl } from './ghost.ts';
import type { SyncConfig } from './config.ts';

const FEED_URL = 'https://www.crucialtracks.org/profile/bryan/feed.json';
const ARCHIVE_TREE_URL = 'https://api.github.com/repos/huckabarry/afterword-sveltekit-pds/git/trees/main?recursive=1';
const ARCHIVE_RAW_BASE = 'https://raw.githubusercontent.com/huckabarry/afterword-sveltekit-pds/main/';
const PLAYLIST_URL = 'https://music.apple.com/us/playlist/crucial-tracks/pl.u-RRbV745t9lJmK';

export interface CrucialTrackEntry {
  sourceUrl: string;
  title: string;
  artist: string;
  albumTitle: string | null;
  albumReleaseYear: string | null;
  note: string;
  noteHtml: string | null;
  publishedAt: string;
  appleMusicUrl: string | null;
  songlinkUrl: string | null;
  previewUrl: string | null;
  artworkUrl: string | null;
  playlistUrl: string | null;
}

export interface ImportCrucialTracksOptions {
  dryRun?: boolean;
  limit?: number;
  offset?: number;
  updateExisting?: boolean;
}

function decodeHtmlEntities(value: string): string {
  return String(value || '').replace(/&(#x?[0-9a-f]+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, body: string) => {
    const normalized = String(body || '').toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'apos') return "'";
    if (normalized === 'gt') return '>';
    if (normalized === 'lt') return '<';
    if (normalized === 'nbsp') return ' ';
    if (normalized === 'quot') return '"';
    const radix = normalized.startsWith('#x') ? 16 : 10;
    const number = Number.parseInt(normalized.replace(/^#x?/, ''), radix);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(value: string): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/['".,!?()[\]{}:;]+/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'track';
}

function splitTitleAndArtist(value: string): { title: string; artist: string } {
  const normalized = decodeHtmlEntities(String(value || '')).replace(/^\*+|\*+$/g, '').trim();
  const match = normalized.match(/^["“”]?(.+?)["“”]?\s+by\s+(.+)$/i);
  return match ? { title: match[1].trim(), artist: match[2].trim() } : { title: normalized || 'Untitled', artist: '' };
}

function entrySlug(entry: CrucialTrackEntry): string {
  const date = entry.sourceUrl.match(/\/(\d{8})$/)?.[1] ?? entry.publishedAt.slice(0, 10).replace(/-/g, '');
  return `listening-${date}-${slugify(entry.title)}-${slugify(entry.artist)}`.slice(0, 180);
}

function imageFilename(entry: CrucialTrackEntry): string {
  return `${entrySlug(entry)}.jpg`;
}

function yearFromDate(value: string | null | undefined): string | null {
  const year = String(value || '').match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
  return year && Number(year) >= 1900 && Number(year) <= 2099 ? year : null;
}

function appleTrackId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('i') || parsed.pathname.match(/\/id(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function appleCollectionId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.pathname.match(/\/(\d+)$/)?.[1] || null;
  } catch {
    return null;
  }
}

function parseFrontmatterMarkdown(source: string): { data: Record<string, string>; content: string } {
  const match = String(source || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: source };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    data[key] = decodeHtmlEntities(value);
  }
  return { data, content: match[2].trim() };
}

function archiveEntryFromMarkdown(markdown: string): CrucialTrackEntry | null {
  const { data, content } = parseFrontmatterMarkdown(markdown);
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = splitTitleAndArtist(lines[0] || '');
  const appleMusicUrl = content.match(/\[Listen on Apple Music\]\(([^)]+)\)/i)?.[1] ?? null;
  const playlistUrl = content.match(/\[Listen to Bryan's Apple Music playlist\]\(([^)]+)\)/i)?.[1] ?? PLAYLIST_URL;
  const noteHtml = content.match(/<div>([\s\S]*?)<\/div>/i)?.[1]?.trim() ?? null;
  if (!data.original_url || !data.published) return null;
  return {
    sourceUrl: data.original_url,
    title: parsed.title,
    artist: parsed.artist,
    albumTitle: null,
    albumReleaseYear: null,
    note: stripHtml(noteHtml || ''),
    noteHtml,
    publishedAt: data.published,
    appleMusicUrl,
    songlinkUrl: null,
    previewUrl: null,
    artworkUrl: null,
    playlistUrl
  };
}

async function readJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'lowvelocity-sync crucial tracks importer' } });
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchLiveFeed(): Promise<CrucialTrackEntry[]> {
  const data = await readJson<{
    items?: Array<{
      url?: string;
      date_published?: string;
      content_html?: string;
      _song_details?: {
        artist?: string;
        song?: string;
        content?: string;
        artwork_url?: string;
        apple_music_url?: string;
        songlink_url?: string;
        preview_url?: string;
      };
    }>;
  }>(FEED_URL, 'Crucial Tracks feed');

  return (data.items ?? []).map((item) => {
    const details = item._song_details ?? {};
    const noteHtml = String(details.content || '').trim() || String(item.content_html || '').match(/<div>([\s\S]*?)<\/div>/i)?.[1]?.trim() || null;
    return {
      sourceUrl: item.url || '',
      title: String(details.song || '').trim(),
      artist: String(details.artist || '').trim(),
      albumTitle: null,
      albumReleaseYear: null,
      note: stripHtml(noteHtml || ''),
      noteHtml,
      publishedAt: item.date_published || new Date().toISOString(),
      appleMusicUrl: details.apple_music_url || null,
      songlinkUrl: details.songlink_url || null,
      previewUrl: details.preview_url || null,
      artworkUrl: details.artwork_url || null,
      playlistUrl: PLAYLIST_URL
    };
  }).filter((entry) => entry.sourceUrl && entry.title);
}

async function fetchArchiveEntries(): Promise<CrucialTrackEntry[]> {
  try {
    const tree = await readJson<{ tree?: Array<{ path?: string; type?: string }> }>(ARCHIVE_TREE_URL, 'GitHub archive tree');
    const paths = (tree.tree ?? [])
      .map((item) => item.path || '')
      .filter((path) => path.startsWith('archive/crucial-tracks/') && path.endsWith('.md'))
      .sort();
    const entries = await Promise.all(paths.map(async (path) => {
      const response = await fetch(`${ARCHIVE_RAW_BASE}${path}`, { headers: { 'User-Agent': 'lowvelocity-sync crucial tracks importer' } });
      return response.ok ? archiveEntryFromMarkdown(await response.text()) : null;
    }));
    return entries.filter((entry): entry is CrucialTrackEntry => Boolean(entry));
  } catch {
    return [];
  }
}

type AppleLookupResult = {
  artworkUrl100?: string;
  collectionName?: string;
  collectionCensoredName?: string;
  previewUrl?: string;
  trackViewUrl?: string;
  collectionViewUrl?: string;
  releaseDate?: string;
};

async function lookupAppleById(id: string, label: string): Promise<AppleLookupResult | null> {
  try {
    const data = await readJson<{ results?: AppleLookupResult[] }>(
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`,
      label
    );
    return data.results?.[0] ?? null;
  } catch (error) {
    console.warn(`${label} failed`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function readAppleMusicAlbumTitle(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'lowvelocity-sync crucial tracks importer'
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];

    for (const script of scripts) {
      const json = script
        .replace(/^<script[^>]*>/i, '')
        .replace(/<\/script>$/i, '')
        .trim();
      try {
        const data = JSON.parse(decodeHtmlEntities(json));
        const albumTitle = data?.inAlbum?.name;
        if (typeof albumTitle === 'string' && albumTitle.trim()) return albumTitle.trim();
      } catch {
        // Keep trying other structured-data blocks.
      }
    }

    return html.match(/"inAlbum"\s*:\s*\{[\s\S]{0,800}?"name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  } catch (error) {
    console.warn('Apple Music page album lookup failed', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function readAppleMusicAlbumYear(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'lowvelocity-sync crucial tracks importer'
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];

    for (const script of scripts) {
      const json = script
        .replace(/^<script[^>]*>/i, '')
        .replace(/<\/script>$/i, '')
        .trim();
      try {
        const data = JSON.parse(decodeHtmlEntities(json));
        const releaseYear = yearFromDate(data?.inAlbum?.datePublished || data?.datePublished);
        if (releaseYear) return releaseYear;
      } catch {
        // Keep trying other structured-data blocks.
      }
    }

    return yearFromDate(html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1]);
  } catch (error) {
    console.warn('Apple Music page year lookup failed', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function enrichFromApple(entry: CrucialTrackEntry): Promise<CrucialTrackEntry> {
  if (entry.artworkUrl && entry.previewUrl && entry.albumTitle && entry.albumReleaseYear) return entry;
  const trackId = appleTrackId(entry.appleMusicUrl);
  const collectionId = appleCollectionId(entry.appleMusicUrl);
  if (!trackId && !collectionId) return entry;

  const trackResult = trackId ? await lookupAppleById(trackId, 'Apple Music track lookup') : null;
  const collectionResult = !trackResult?.collectionName && collectionId && collectionId !== trackId
    ? await lookupAppleById(collectionId, 'Apple Music collection lookup')
    : null;
  const result = trackResult ?? collectionResult;
  const albumResult = collectionResult ?? trackResult;
  const albumTitle = entry.albumTitle
    || albumResult?.collectionName
    || albumResult?.collectionCensoredName
    || await readAppleMusicAlbumTitle(entry.appleMusicUrl);
  const albumReleaseYear = entry.albumReleaseYear
    || yearFromDate(albumResult?.releaseDate)
    || await readAppleMusicAlbumYear(entry.appleMusicUrl);
  const artworkUrl = result?.artworkUrl100?.replace(/\/100x100bb\.(jpg|png|webp)$/i, '/600x600bb.$1') ?? entry.artworkUrl;

  return {
    ...entry,
    albumTitle,
    albumReleaseYear,
    artworkUrl,
    previewUrl: entry.previewUrl || trackResult?.previewUrl || null,
    appleMusicUrl: entry.appleMusicUrl || trackResult?.trackViewUrl || collectionResult?.collectionViewUrl || null
  };
}

async function getMergedCrucialTrackEntries(): Promise<CrucialTrackEntry[]> {
  const [live, archive] = await Promise.all([fetchLiveFeed(), fetchArchiveEntries()]);
  const bySourceUrl = new Map<string, CrucialTrackEntry>();
  for (const entry of archive) bySourceUrl.set(entry.sourceUrl, entry);
  for (const entry of live) bySourceUrl.set(entry.sourceUrl, { ...(bySourceUrl.get(entry.sourceUrl) ?? {}), ...entry });
  return [...bySourceUrl.values()].sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let index = 0;

  async function worker() {
    while (index < values.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(values[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function getCrucialTrackEntries(): Promise<CrucialTrackEntry[]> {
  const entries = await getMergedCrucialTrackEntries();
  return mapWithConcurrency(entries, 4, enrichFromApple);
}

function musicPostHtml(entry: CrucialTrackEntry): string {
  const links = [
    entry.previewUrl ? `<a href="${escapeHtml(entry.previewUrl)}" rel="noopener">Preview audio</a>` : '',
    entry.appleMusicUrl ? `<a href="${escapeHtml(entry.appleMusicUrl)}" rel="noopener">Apple Music</a>` : '',
    entry.songlinkUrl ? `<a href="${escapeHtml(entry.songlinkUrl)}" rel="noopener">Listen elsewhere</a>` : '',
    entry.playlistUrl ? `<a href="${escapeHtml(entry.playlistUrl)}" rel="noopener">Playlist</a>` : '',
    entry.sourceUrl ? `<a href="${escapeHtml(entry.sourceUrl)}" rel="noopener">Crucial Tracks</a>` : ''
  ].filter(Boolean).join('');
  const albumHeading = entry.albumTitle
    ? `${escapeHtml(entry.albumTitle)}${entry.albumReleaseYear ? ` <span class="lv-listening-entry__year">(${escapeHtml(entry.albumReleaseYear)})</span>` : ''}`
    : '';

  return [
    '<div class="lv-listening-entry">',
    '<div class="lv-listening-entry__body">',
    links ? `<p class="lv-listening-entry__links">${links}</p>` : '',
    albumHeading ? `<h2>${albumHeading}</h2>` : '',
    entry.artist ? `<p class="lv-listening-entry__artist">${escapeHtml(entry.artist)}</p>` : '',
    entry.noteHtml ? `<div class="lv-listening-entry__note">${entry.noteHtml}</div>` : '',
    '</div>',
    '</div>'
  ].filter(Boolean).join('\n');
}

function customExcerpt(entry: CrucialTrackEntry): string {
  return [entry.note, `${entry.title}${entry.artist ? ` by ${entry.artist}` : ''}`].filter(Boolean).join(' — ').slice(0, 300);
}

export async function ensureListeningPage(config: SyncConfig, dryRun = false) {
  const existing = await findGhostPostBySlug(config, 'listening', 'pages');
  if (dryRun) return { action: existing ? 'would-update' : 'would-create', slug: 'listening' };
  const input = {
    slug: 'listening',
    title: 'Listening',
    html: '<p>Track notes from Crucial Tracks.</p>',
    custom_excerpt: 'Track notes from Crucial Tracks.',
    status: 'published' as const
  };
  const page = existing
    ? await updateGhostHtmlEntry(config, existing, input, 'pages')
    : await createGhostHtmlEntry(config, input, 'pages');
  return { action: existing ? 'updated' : 'created', slug: page.slug, url: page.url };
}

export async function importCrucialTracks(config: SyncConfig, options: ImportCrucialTracksOptions = {}) {
  const entries = await getMergedCrucialTrackEntries();
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(20, options.limit ?? 10));
  const selected = await mapWithConcurrency(entries.slice(offset, offset + limit), 4, enrichFromApple);
  const results = [];

  for (const entry of selected) {
    const slug = entrySlug(entry);
    const existing = await findGhostPostBySlug(config, slug);
    if (options.dryRun) {
      results.push({ action: existing ? 'would-update' : 'would-create', slug, title: entry.title, sourceUrl: entry.sourceUrl });
      continue;
    }
    if (existing && !options.updateExisting) {
      results.push({ action: 'exists', slug, title: entry.title, url: existing.url });
      continue;
    }

    const ghostImageUrl = existing?.feature_image || (entry.artworkUrl ? await uploadGhostImageFromUrl(config, entry.artworkUrl, imageFilename(entry)) : null);
    const input = {
      slug,
      title: `${entry.title}${entry.artist ? ` — ${entry.artist}` : ''}`,
      html: musicPostHtml(entry),
      custom_excerpt: customExcerpt(entry),
      feature_image: ghostImageUrl,
      published_at: new Date(entry.publishedAt).toISOString(),
      tags: [{ name: 'listening' }, { name: '#crucialtracks' }],
      status: 'published' as const
    };
    const post = existing
      ? await updateGhostHtmlEntry(config, existing, input)
      : await createGhostHtmlEntry(config, input);
    results.push({ action: existing ? 'updated' : 'created', slug: post.slug, title: post.title, url: post.url });
  }

  return {
    total: entries.length,
    offset,
    limit,
    processed: selected.length,
    nextOffset: offset + selected.length < entries.length ? offset + selected.length : null,
    results
  };
}
