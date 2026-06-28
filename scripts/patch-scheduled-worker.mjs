import { readFile, writeFile } from 'node:fs/promises';

const workerPath = '.svelte-kit/cloudflare/_worker.js';
const marker = 'lowvelocity-scheduled-imports';

function assertScheduledPatch(source) {
  const required = [
    marker,
    'async scheduled(controller, env2, ctx)',
    'worker_default.fetch(request, env2, ctx)',
    'runScheduledBlueskyImport(env2, ctx, controller)',
    'runScheduledCheckinsImport(env2, ctx, controller)',
    'runScheduledCrucialTracksImport(env2, ctx, controller)'
  ];

  const missing = required.filter((value) => !source.includes(value));
  if (missing.length) {
    throw new Error(`Scheduled importer patch is incomplete. Missing: ${missing.join(', ')}`);
  }

  if (source.includes('fetch(`${baseUrl}/admin/import/')) {
    throw new Error('Scheduled importer patch still uses public self-HTTP instead of internal Worker dispatch');
  }
}

const scheduledHelper = `
// ${marker}
async function runScheduledImport(env2, ctx, controller, job) {
  const token = String(env2.GHOST_STAFF_ACCESS_TOKEN || '').trim();
  if (!token) {
    console.log(JSON.stringify({
      message: \`scheduled \${job.name} import skipped\`,
      reason: 'missing Ghost staff token',
      cron: controller?.cron || ''
    }));
    return;
  }

  const request = new Request(\`https://sync.lowvelocity.org\${job.path}\`, {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${token}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(job.body)
  });

  const response = await worker_default.fetch(request, env2, ctx);
  const text = await response.text();
  if (!response.ok) {
    console.warn(JSON.stringify({
      message: \`scheduled \${job.name} import failed\`,
      cron: controller?.cron || '',
      status: response.status,
      result: text
    }));
    return;
  }

  console.log(JSON.stringify({
    message: \`scheduled \${job.name} import processed\`,
    cron: controller?.cron || '',
    status: response.status,
    result: text ? JSON.parse(text) : null
  }));
}

async function runScheduledBlueskyImport(env2, ctx, controller) {
  await runScheduledImport(env2, ctx, controller, {
    name: 'Bluesky',
    path: '/admin/import/bluesky',
    body: {
      dryRun: false,
      updateExisting: false,
      uploadImages: true,
      limit: 10,
      maxPages: 2,
      sinceTag: '#bluesky'
    }
  });
}

async function runScheduledCheckinsImport(env2, ctx, controller) {
  const foursquareToken = String(env2.FOURSQUARE_ACCESS_TOKEN || env2.SWARM_ACCESS_TOKEN || '').trim();
  const hasCheckinsTokenStore = Boolean(env2.CHECKINS_KV);
  if (!foursquareToken && !hasCheckinsTokenStore) {
    console.log(JSON.stringify({
      message: 'scheduled check-ins import skipped',
      reason: 'missing Foursquare access token or CHECKINS_KV binding',
      cron: controller?.cron || ''
    }));
    return;
  }

  const scheduledTime = Number(controller?.scheduledTime || Date.now());
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (minute % 15 !== 0) return;

  await runScheduledImport(env2, ctx, controller, {
    name: 'check-ins',
    path: '/admin/import/checkins',
    body: {
      dryRun: false,
      updateExisting: false,
      uploadImages: true,
      limit: 20,
      maxPages: 2,
      sinceTag: 'check-ins'
    }
  });
}

async function runScheduledCrucialTracksImport(env2, ctx, controller) {
  const scheduledTime = Number(controller?.scheduledTime || Date.now());
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (minute % 5 !== 0) return;

  await runScheduledImport(env2, ctx, controller, {
    name: 'Crucial Tracks',
    path: '/admin/import/crucial-tracks',
    body: {
      dryRun: false,
      updateExisting: false,
      ensurePage: false,
      limit: 3,
      offset: 0,
      order: 'desc'
    }
  });
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
    await runScheduledBlueskyImport(env2, ctx, controller);
    await runScheduledCheckinsImport(env2, ctx, controller);
    await runScheduledCrucialTracksImport(env2, ctx, controller);
  },
` +
    source.slice(index + target.length);

  await writeFile(workerPath, source);
  console.log(`Patched ${workerPath} with scheduled importers`);
} else {
  console.log(`${workerPath} already contains scheduled importers`);
}

assertScheduledPatch(source);
