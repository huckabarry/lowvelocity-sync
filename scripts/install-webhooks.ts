import { createGhostAdminToken } from '../src/lib/server/crypto.ts';

const EVENTS = ['post.published', 'post.published.edited', 'post.unpublished', 'post.deleted'];
const TARGET_URL = 'https://sync.lowvelocity.org/webhooks/ghost';

interface Input { adminApiKey?: string; webhookSecret?: string; }

async function readInput(): Promise<Input> {
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve) => {
      let value = '';
      process.stdin.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (text.includes('\u0004')) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          resolve(JSON.parse(value + text.replace('\u0004', '')) as Input);
        } else value += text;
      });
    });
  }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input) as Input;
}

const input = await readInput();
if (!input.adminApiKey || !input.webhookSecret) throw new Error('Missing setup credentials');
const token = await createGhostAdminToken(input.adminApiKey);
const summary: { created: string[]; existing: string[]; failed: { event: string; status: number; message: string }[] } = {
  created: [], existing: [], failed: []
};

for (const event of EVENTS) {
  const response = await fetch('https://lowvelocity.org/ghost/api/admin/webhooks/', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Version': 'v5.0',
      Authorization: `Ghost ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      webhooks: [{ event, target_url: TARGET_URL, secret: input.webhookSecret, name: `Low Velocity Standard.site — ${event}` }]
    })
  });
  if (response.ok) {
    summary.created.push(event);
    continue;
  }
  const text = await response.text();
  if (/already|exists?|duplicate|used for this event/i.test(text)) summary.existing.push(event);
  else summary.failed.push({ event, status: response.status, message: text.slice(0, 500) });
}

console.log(JSON.stringify(summary, null, 2));
if (summary.failed.length) process.exitCode = 1;
