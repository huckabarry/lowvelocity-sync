import { writeFile } from 'node:fs/promises';

const PIKA_ENDPOINT = 'https://pika.page/micropub';
const TOKEN = process.env.PIKA_MICROPUB_TOKEN?.trim();

const corrections = [
  { url: 'https://bryan.pika.page/posts/2026-08-23-when-i-lived-in', published: '2025-01-10T18:06:08.000Z' },
  { url: 'https://bryan.pika.page/posts/2026-08-23-when-you-moved-thousands', published: '2026-08-21T20:25:46.207Z' },
  { url: 'https://bryan.pika.page/posts/2026-08-23-but-it-is-the', published: '2026-08-17T02:19:32.969Z' },
  { url: 'https://bryan.pika.page/posts/2026-08-23-i-keep-coming-back', published: '2026-08-14T00:50:08.038Z' },
  { url: 'https://bryan.pika.page/posts/2026-08-23-this-all-day-html', published: '2026-08-21T04:51:01.172Z' }
];

if (!TOKEN) throw new Error('PIKA_MICROPUB_TOKEN is required');

const results: Array<{ url: string; published: string; status?: number; error?: string }> = [];
for (const correction of corrections) {
  const result = { ...correction, status: undefined as number | undefined, error: undefined as string | undefined };
  const response = await fetch(PIKA_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'update',
      url: correction.url,
      replace: { published: [correction.published] }
    })
  });
  result.status = response.status;
  if (response.status !== 200) result.error = (await response.text()).slice(0, 300);
  results.push(result);
  console.log(JSON.stringify(result));
  await writeFile('pika-date-corrections.json', JSON.stringify({ results }, null, 2));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

if (results.some((result) => result.error)) process.exitCode = 1;
