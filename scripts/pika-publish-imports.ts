import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PIKA_ENDPOINT = 'https://pika.page/micropub';
const TOKEN = process.env.PIKA_MICROPUB_TOKEN?.trim();
const REPORTS_DIR = process.env.REPORTS_DIR ?? 'pika-import-reports';
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH ?? 'pika-publish-checkpoint.json';
const EXPECTED_COUNT = Number(process.env.EXPECTED_COUNT ?? 1_889);
const START_INDEX = Math.max(0, Number(process.env.START_INDEX ?? 0));
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS ?? 2_000));
const DRY_RUN = process.argv.includes('--dry-run');

interface ImportEntry {
  uri: string;
  createdAt: string;
  location?: string;
  error?: string;
}

interface ImportReport {
  selected?: ImportEntry[];
}

interface PublishEntry extends ImportEntry {
  url: string;
  status?: 'published';
  error?: string;
}

async function jsonFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files;
}

function publicPostUrl(location: string): string {
  const url = new URL(location);
  url.pathname = url.pathname.replace(/\/edit\/?$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function loadImports(): Promise<PublishEntry[]> {
  const byUri = new Map<string, ImportEntry>();
  for (const file of await jsonFiles(REPORTS_DIR)) {
    const report = JSON.parse(await readFile(file, 'utf8')) as ImportReport;
    for (const entry of report.selected ?? []) {
      const existing = byUri.get(entry.uri);
      if (!existing || (!existing.location && entry.location)) byUri.set(entry.uri, entry);
    }
  }
  const imports = [...byUri.values()].filter((entry) => entry.location && entry.createdAt).map((entry) => ({
    ...entry,
    url: publicPostUrl(entry.location!)
  }));
  if (imports.length !== EXPECTED_COUNT) {
    throw new Error(`Expected ${EXPECTED_COUNT} unique imported drafts, found ${imports.length}`);
  }
  return imports.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function pikaFetch(body: object): Promise<Response> {
  if (!TOKEN) throw new Error('PIKA_MICROPUB_TOKEN is required');
  let delay = 60_000;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(PIKA_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (response.status !== 429 || attempt === 5) return response;
    console.warn(JSON.stringify({ rateLimited: true, retryInMs: delay }));
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= 2;
  }
  throw new Error('Pika backoff exhausted');
}

async function publish(entry: PublishEntry): Promise<void> {
  const response = await pikaFetch({
    action: 'update',
    url: entry.url,
    replace: {
      'post-status': ['published'],
      published: [entry.createdAt]
    }
  });
  if (response.status !== 200 && response.status !== 201) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Pika publish update failed: HTTP ${response.status} ${detail}`);
  }
}

const imports = await loadImports();
const remaining = imports.slice(START_INDEX);
const report: PublishEntry[] = [];
for (const source of remaining) {
  const entry: PublishEntry = { ...source };
  delete entry.error;
  if (!DRY_RUN) {
    try {
      await publish(entry);
      entry.status = 'published';
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  report.push(entry);
  console.log(JSON.stringify({ uri: entry.uri, url: entry.url, status: entry.status, error: entry.error }));
  await writeFile(CHECKPOINT_PATH, JSON.stringify({ dryRun: DRY_RUN, expected: EXPECTED_COUNT, startIndex: START_INDEX, selected: remaining.length, processed: report.length, results: report }, null, 2));
  if (!DRY_RUN && report.length < remaining.length) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
}

if (report.some((entry) => entry.error)) process.exitCode = 1;
