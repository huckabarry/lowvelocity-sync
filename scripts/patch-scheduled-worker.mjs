import { readFile, writeFile } from 'node:fs/promises';

const workerPath = '.svelte-kit/cloudflare/_worker.js';
const marker = 'lowvelocity-scheduled-bluesky-import';

const scheduledHelper = `
// ${marker}
async function runScheduledBlueskyImport(env2, controller) {
  const token = String(env2.GHOST_STAFF_ACCESS_TOKEN || '').trim();
  if (!token) {
    throw new Error('Missing GHOST_STAFF_ACCESS_TOKEN for scheduled Bluesky import');
  }

  const baseUrl = String(env2.SYNC_BASE_URL || 'https://sync.lowvelocity.org').replace(/\\/$/, '');
  const response = await fetch(\`\${baseUrl}/admin/import/bluesky\`, {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${token}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      dryRun: false,
      updateExisting: false,
      uploadImages: true,
      limit: 10,
      maxPages: 2,
      sinceTag: '#bluesky'
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(\`Scheduled Bluesky import failed with \${response.status}: \${text}\`);
  }

  console.log(JSON.stringify({
    message: 'scheduled Bluesky import processed',
    cron: controller?.cron || '',
    status: response.status,
    result: text ? JSON.parse(text) : null
  }));
}
`;

let source = await readFile(workerPath, 'utf8');

if (!source.includes(marker)) {
  const target = 'var worker_default = {';
  const index = source.indexOf(target);
  if (index === -1) {
    throw new Error(`Unable to find generated Worker export in ${workerPath}`);
  }

  source =
    source.slice(0, index) +
    scheduledHelper +
    target +
    `
  async scheduled(controller, env2, ctx) {
    void ctx;
    await runScheduledBlueskyImport(env2, controller);
  },
` +
    source.slice(index + target.length);

  await writeFile(workerPath, source);
  console.log(`Patched ${workerPath} with scheduled Bluesky importer`);
} else {
  console.log(`${workerPath} already contains scheduled Bluesky importer`);
}
