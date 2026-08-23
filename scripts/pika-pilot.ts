import { writeFile } from 'node:fs/promises';

const DID = 'did:plc:vt4k6d3e5rjw65cuzaf3nufq';
const HANDLE = 'bryan.eurosky.social';
const PIKA_ENDPOINT = 'https://pika.page/micropub';
const MEDIA_ENDPOINT = 'https://pika.page/micropub/media';
const TOKEN = process.env.PIKA_MICROPUB_TOKEN?.trim();
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_URIS = new Set([
  `at://${DID}/app.bsky.feed.post/3mtrdzzvew22s`,
  `at://${DID}/app.bsky.feed.post/3mtrdgzvky22s`,
  `at://${DID}/app.bsky.feed.post/3mtptmwdofs2o`,
  `at://${DID}/app.bsky.feed.post/3mtpavckbms2o`
]);
const CREATED_PILOT_URIS = new Set([
  `at://${DID}/app.bsky.feed.post/3mtnmsbmuec2e`,
  `at://${DID}/app.bsky.feed.post/3mtndw47rxs2v`,
  `at://${DID}/app.bsky.feed.post/3mtmqerdihk2t`,
  `at://${DID}/app.bsky.feed.post/3mtmlsk4rps2i`
]);

type CandidateKind = 'external' | 'quote' | 'image' | 'video';

interface FeedItem {
  reason?: unknown;
  post?: {
    uri?: string;
    cid?: string;
    author?: { did?: string; handle?: string };
    record?: { text?: string; createdAt?: string; reply?: unknown };
    embed?: EmbedView;
  };
}

interface EmbedView {
  $type?: string;
  images?: ImageView[];
  items?: ImageView[];
  external?: ExternalView;
  record?: QuoteView;
  media?: EmbedView;
  playlist?: string;
}

interface ImageView {
  fullsize?: string;
  thumb?: string;
  thumbnail?: string;
  alt?: string;
}

interface ExternalView {
  uri?: string;
  title?: string;
  description?: string;
  thumb?: string;
}

interface QuoteView {
  uri?: string;
  cid?: string;
  author?: { handle?: string; displayName?: string };
  value?: { text?: string };
  embeds?: EmbedView[];
}

interface Candidate {
  kind: CandidateKind;
  uri: string;
  cid: string;
  text: string;
  createdAt: string;
  embed: EmbedView;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replace(/([\[\]_*`])/g, '\\$1');
}

function blueskyUrl(uri: string, handle = HANDLE): string {
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(uri.split('/').at(-1) ?? '')}`;
}

function classify(embed: EmbedView | undefined): CandidateKind | null {
  const type = embed?.$type ?? '';
  if (type.includes('video#view') || embed?.playlist || embed?.media?.playlist) return 'video';
  if (embed?.record?.uri) return 'quote';
  if (embed?.external?.uri || embed?.media?.external?.uri) return 'external';
  if ((embed?.images?.length ?? 0) > 0 || (embed?.items?.length ?? 0) > 0 || (embed?.media?.images?.length ?? 0) > 0) return 'image';
  return null;
}

async function fetchCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 15; page += 1) {
    const url = new URL('/xrpc/app.bsky.feed.getAuthorFeed', 'https://public.api.bsky.app');
    url.searchParams.set('actor', DID);
    url.searchParams.set('filter', 'posts_with_replies');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bluesky feed request failed: HTTP ${response.status}`);
    const body = await response.json() as { feed?: FeedItem[]; cursor?: string };

    for (const item of body.feed ?? []) {
      const post = item.post;
      const record = post?.record;
      if (!post?.uri || !post.cid || !record?.createdAt || !post.embed) continue;
      if (post.author?.did !== DID || item.reason || record.reply || SKIP_URIS.has(post.uri)) continue;
      const kind = classify(post.embed);
      if (!kind) continue;
      candidates.push({
        kind,
        uri: post.uri,
        cid: post.cid,
        text: record.text ?? '',
        createdAt: record.createdAt,
        embed: post.embed
      });
    }

    cursor = body.cursor;
    if (!cursor) break;
  }

  const targets: Record<CandidateKind, number> = { external: 3, quote: 3, image: 2, video: 1 };
  const selected: Candidate[] = [];
  for (const kind of Object.keys(targets) as CandidateKind[]) {
    selected.push(...candidates.filter((candidate) => candidate.kind === kind).slice(0, targets[kind]));
  }
  return selected.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function images(embed: EmbedView): ImageView[] {
  return embed.images ?? embed.items ?? embed.media?.images ?? [];
}

async function uploadSource(source: string, alt: string, index: number): Promise<{ value: string; alt: string }> {
  if (!TOKEN) throw new Error('PIKA_MICROPUB_TOKEN is required');
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Bluesky image download failed: HTTP ${response.status}`);
  const blob = await response.blob();
  const form = new FormData();
  form.set('file', blob, `bluesky-${index + 1}.${blob.type === 'image/png' ? 'png' : 'jpg'}`);
  const upload = await fetch(MEDIA_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form
  });
  const location = upload.headers.get('location');
  if (upload.status !== 201 || !location) {
    const detail = (await upload.text()).slice(0, 200);
    throw new Error(`Pika media upload failed: HTTP ${upload.status} ${detail}`);
  }
  return { value: location, alt };
}

async function uploadImage(image: ImageView, index: number): Promise<{ value: string; alt: string }> {
  const source = image.fullsize ?? image.thumb ?? image.thumbnail;
  if (!source) throw new Error('Bluesky image has no usable URL');
  return uploadSource(source, image.alt ?? '', index);
}

function externalCard(external: ExternalView, localThumb?: string): string {
  if (!external.uri) return '';
  const domain = (() => {
    try { return new URL(external.uri).hostname.replace(/^www\./, ''); } catch { return external.uri; }
  })();
  return [
    '<article class="bluesky-import-card bluesky-import-card--external">',
    `  <a href="${escapeHtml(external.uri)}" rel="noopener noreferrer">`,
    localThumb ? `    <img src="${escapeHtml(localThumb)}" alt="">` : '',
    `    <small>${escapeHtml(domain)}</small>`,
    external.title ? `    <strong>${escapeHtml(external.title)}</strong>` : '',
    external.description ? `    <span>${escapeHtml(external.description)}</span>` : '',
    '  </a>',
    '</article>'
  ].filter(Boolean).join('\n');
}

function quoteCard(quote: QuoteView, imageCount: number): string {
  if (!quote.uri) return '';
  const handle = quote.author?.handle ?? '';
  const label = quote.author?.displayName || (handle ? `@${handle}` : 'Quoted post');
  return [
    `<blockquote class="bluesky-import-card bluesky-import-card--quote" data-quote-images="${imageCount}">`,
    `  <a href="${escapeHtml(blueskyUrl(quote.uri, handle || HANDLE))}" rel="noopener noreferrer"><strong>${escapeHtml(label)}</strong></a>`,
    quote.value?.text ? `  <p>${escapeHtml(quote.value.text)}</p>` : '',
    '</blockquote>'
  ].filter(Boolean).join('\n');
}

async function buildContent(candidate: Candidate): Promise<string> {
  const parts = [escapeMarkdown(candidate.text)];
  let quoteImages: Array<{ value: string; alt: string }> = [];
  if (candidate.kind === 'image') {
    const uploaded = [];
    for (const [index, image] of images(candidate.embed).entries()) uploaded.push(await uploadImage(image, index));
    for (const photo of uploaded) parts.push(`![${escapeMarkdown(photo.alt)}](${photo.value})`);
  }

  let card = '';
  if (candidate.kind === 'external') {
    const external = candidate.embed.external ?? candidate.embed.media?.external ?? {};
    const localThumb = external.thumb ? await uploadSource(external.thumb, '', 0).then((image) => image.value).catch(() => undefined) : undefined;
    card = externalCard(external, localThumb);
  }
  if (candidate.kind === 'quote') {
    const quote = candidate.embed.record ?? {};
    for (const [index, image] of images(quote.embeds?.[0] ?? {}).entries()) quoteImages.push(await uploadImage(image, index));
    card = quoteCard(quote, quoteImages.length);
  }
  if (candidate.kind === 'video') {
    const thumbnail = candidate.embed.thumbnail ?? candidate.embed.media?.thumbnail;
    const localPoster = thumbnail ? await uploadSource(thumbnail, '', 0).then((image) => image.value).catch(() => undefined) : undefined;
    card = [
      '<p class="bluesky-import-video">',
      `  <a href="${escapeHtml(blueskyUrl(candidate.uri))}" rel="noopener noreferrer">`,
      localPoster ? `    <img src="${escapeHtml(localPoster)}" alt="">` : '',
      '    <span>Watch this video on Bluesky</span>',
      '  </a>',
      '</p>'
    ].filter(Boolean).join('\n');
  }

  const marker = `<div class="bluesky-conversation" data-at-uri="${escapeHtml(candidate.uri)}" data-cid="${escapeHtml(candidate.cid)}"></div>`;
  if (card) parts.push(`\`\`\`pikahtml\n${card}\n\`\`\``);
  for (const photo of quoteImages) parts.push(`![${escapeMarkdown(photo.alt)}](${photo.value})`);
  parts.push(`\`\`\`pikahtml\n${marker}\n\`\`\``);
  return parts.filter(Boolean).join('\n\n');
}

async function createDraft(candidate: Candidate): Promise<string> {
  if (!TOKEN) throw new Error('PIKA_MICROPUB_TOKEN is required');
  const content = await buildContent(candidate);
  const response = await fetch(PIKA_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: ['h-entry'],
      properties: {
        content: [content],
        category: ['bluesky'],
        published: [candidate.createdAt],
        'post-status': ['draft']
      }
    })
  });
  const location = response.headers.get('location');
  if (response.status !== 201 || !location) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Pika draft creation failed: HTTP ${response.status} ${detail}`);
  }
  return location;
}

const selected = (await fetchCandidates()).filter((candidate) => !CREATED_PILOT_URIS.has(candidate.uri));
const report: Array<{ kind: CandidateKind; uri: string; createdAt: string; location?: string }> = [];
for (const candidate of selected) {
  const entry = { kind: candidate.kind, uri: candidate.uri, createdAt: candidate.createdAt, location: undefined as string | undefined };
  if (!DRY_RUN) {
    entry.location = await createDraft(candidate);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  report.push(entry);
  console.log(JSON.stringify(entry));
}

await writeFile('pika-pilot-report.json', JSON.stringify({ dryRun: DRY_RUN, selected: report }, null, 2));
