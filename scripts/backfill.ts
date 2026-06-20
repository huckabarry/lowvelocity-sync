import { createHmac } from 'node:crypto';
import { createGhostAdminToken } from '../src/lib/server/crypto.ts';

const INCLUDED_TAGS = new Set(['field-notes', 'urbanism', 'housing', 'transportation', 'public-finance']);
const EXCLUDED_TAGS = new Set(['status', 'note', 'notes', 'afterword']);
const SYNC_URL = 'https://sync.lowvelocity.org/webhooks/ghost';

interface Input {
  adminApiKey?: string;
  webhookSecret?: string;
  dryRun?: boolean;
  delayMs?: number;
}

interface GhostPost {
  id: string;
  slug: string;
  title: string;
  status: string;
  visibility?: string;
  page?: boolean;
  url?: string;
  codeinjection_head?: string | null;
  tags?: { name?: string; slug?: string }[];
}

async function readSecretInput(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    return value;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    process.stdin.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('\u0004')) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(value + text.replace('\u0004', ''));
      } else value += text;
    });
  });
}

function tagSlugs(post: GhostPost): string[] {
  return (post.tags ?? []).map((tag) => tag.slug ?? '').filter(Boolean);
}

function belongsInBackfill(post: GhostPost): boolean {
  const tags = tagSlugs(post);
  return post.status === 'published'
    && post.visibility === 'public'
    && !post.page
    && tags.some((tag) => INCLUDED_TAGS.has(tag))
    && !tags.some((tag) => EXCLUDED_TAGS.has(tag));
}

function isAlreadySynced(post: GhostPost): boolean {
  return /rel=["']site\.standard\.document["']/.test(post.codeinjection_head ?? '');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliver(post: GhostPost, webhookSecret: string): Promise<{ ok: boolean; uri?: string; error?: string }> {
  const payload = JSON.stringify({ post: { current: post } });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', webhookSecret).update(payload).update(timestamp).digest('hex');
    const response = await fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ghost-Signature': `sha256=${signature}, t=${timestamp}` },
      body: payload
    });
    const result = await response.json() as { ok?: boolean; uri?: string; error?: string };
    if (response.ok && result.ok) return { ok: true, uri: result.uri };
    if (attempt === 3 || (response.status < 429 && response.status < 500)) {
      return { ok: false, error: result.error ?? `HTTP ${response.status}` };
    }
    await wait(attempt * 5000);
  }
  return { ok: false, error: 'Retry limit reached' };
}

const input = JSON.parse(process.env.BACKFILL_INPUT ?? await readSecretInput()) as Input;
if (!input.adminApiKey || !input.webhookSecret) throw new Error('Missing backfill credentials');
const token = await createGhostAdminToken(input.adminApiKey);
const headers = { Accept: 'application/json', 'Accept-Version': 'v5.0', Authorization: `Ghost ${token}` };
const published: GhostPost[] = [];
let page = 1;
while (page) {
  const postsUrl = new URL('/ghost/api/admin/posts/', 'https://lowvelocity.org');
  postsUrl.searchParams.set('limit', '100');
  postsUrl.searchParams.set('page', String(page));
  postsUrl.searchParams.set('include', 'tags');
  postsUrl.searchParams.set('filter', `status:published+tag:[${[...INCLUDED_TAGS].join(',')}]`);
  const response = await fetch(postsUrl, { headers });
  if (!response.ok) throw new Error(`Ghost browse failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as {
    posts?: GhostPost[];
    meta?: { pagination?: { next?: number | null } };
  };
  published.push(...(body.posts ?? []));
  page = body.meta?.pagination?.next ?? 0;
}
const eligible = published.filter(belongsInBackfill);
const existing = eligible.filter(isAlreadySynced);
const candidates = eligible.filter((post) => !isAlreadySynced(post));

console.log(JSON.stringify({
  mode: input.dryRun === false ? 'execute' : 'dry-run',
  eligible: eligible.length,
  alreadySynced: existing.length,
  candidates: candidates.map((post) => ({ title: post.title, slug: post.slug, tags: tagSlugs(post) }))
}, null, 2));

if (input.dryRun !== false) process.exit(0);
const delayMs = Math.max(1500, input.delayMs ?? 2500);
const summary = { synced: [] as string[], failed: [] as { slug: string; error: string }[] };
for (const [index, post] of candidates.entries()) {
  const result = await deliver(post, input.webhookSecret);
  if (result.ok) {
    summary.synced.push(post.slug);
    console.log(`[${index + 1}/${candidates.length}] synced ${post.slug}`);
  } else {
    summary.failed.push({ slug: post.slug, error: result.error ?? 'Unknown error' });
    console.error(`[${index + 1}/${candidates.length}] failed ${post.slug}: ${result.error}`);
  }
  if (index < candidates.length - 1) await wait(delayMs);
}
console.log(JSON.stringify(summary, null, 2));
if (summary.failed.length) process.exitCode = 1;
