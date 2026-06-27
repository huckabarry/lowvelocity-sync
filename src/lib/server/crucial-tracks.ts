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

function appleTrackId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('i') || parsed.pathname.match(/\/id(\d+)/)?.[1] || null;
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

async function enrichFromApple(entry: CrucialTrackEntry): Promise<CrucialTrackEntry> {
  if (entry.artworkUrl && entry.previewUrl) return entry;
  const id = appleTrackId(entry.appleMusicUrl);
  if (!id) return entry;
  try {
    const data = await readJson<{ results?: Array<{ artworkUrl100?: string; previewUrl?: string; trackViewUrl?: string }> }>(
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`,
      'Apple Music lookup'
    );
    const result = data.results?.[0];
    const artworkUrl = result?.artworkUrl100?.replace(/\/100x100bb\.(jpg|png|webp)$/i, '/600x600bb.$1') ?? entry.artworkUrl;
    return {
      ...entry,
      artworkUrl,
      previewUrl: entry.previewUrl || result?.previewUrl || null,
      appleMusicUrl: entry.appleMusicUrl || result?.trackViewUrl || null
    };
  } catch {
    return entry;
  }
}

export async function getCrucialTrackEntries(): Promise<CrucialTrackEntry[]> {
  const [live, archive] = await Promise.all([fetchLiveFeed(), fetchArchiveEntries()]);
  const bySourceUrl = new Map<string, CrucialTrackEntry>();
  for (const entry of archive) bySourceUrl.set(entry.sourceUrl, entry);
  for (const entry of live) bySourceUrl.set(entry.sourceUrl, { ...(bySourceUrl.get(entry.sourceUrl) ?? {}), ...entry });
  const enriched = await Promise.all([...bySourceUrl.values()].map(enrichFromApple));
  return enriched.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
}

function musicPostHtml(entry: CrucialTrackEntry): string {
  const links = [
    entry.previewUrl ? `<a href="${escapeHtml(entry.previewUrl)}" rel="noopener">Preview audio</a>` : '',
    entry.appleMusicUrl ? `<a href="${escapeHtml(entry.appleMusicUrl)}" rel="noopener">Apple Music</a>` : '',
    entry.songlinkUrl ? `<a href="${escapeHtml(entry.songlinkUrl)}" rel="noopener">Listen elsewhere</a>` : '',
    entry.playlistUrl ? `<a href="${escapeHtml(entry.playlistUrl)}" rel="noopener">Playlist</a>` : '',
    entry.sourceUrl ? `<a href="${escapeHtml(entry.sourceUrl)}" rel="noopener">Crucial Tracks</a>` : ''
  ].filter(Boolean).join('');

  return [
    '<div class="lv-listening-entry">',
    '<div class="lv-listening-entry__body">',
    '<p class="lv-listening-entry__eyebrow">Listening</p>',
    `<h2>${escapeHtml(entry.title)}</h2>`,
    entry.artist ? `<p class="lv-listening-entry__artist">${escapeHtml(entry.artist)}</p>` : '',
    entry.noteHtml ? `<div class="lv-listening-entry__note">${entry.noteHtml}</div>` : '',
    links ? `<p class="lv-listening-entry__links">${links}</p>` : '',
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
  const entries = await getCrucialTrackEntries();
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(20, options.limit ?? 10));
  const selected = entries.slice(offset, offset + limit);
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
