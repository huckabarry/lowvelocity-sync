interface Input { appPassword?: string; rkey?: string; }

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

const input = JSON.parse(await readSecretInput()) as Input;
if (!input.appPassword || !input.rkey) throw new Error('Missing app password or record key');
const service = 'https://enoki.us-east.host.bsky.network';
const sessionResponse = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'lowvelocity.org', password: input.appPassword })
});
if (!sessionResponse.ok) throw new Error(`PDS login failed: ${sessionResponse.status}`);
const session = await sessionResponse.json() as { did: string; accessJwt: string };
const response = await fetch(`${service}/xrpc/com.atproto.repo.deleteRecord`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ repo: session.did, collection: 'site.standard.document', rkey: input.rkey })
});
if (!response.ok) throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
console.log(JSON.stringify({ deleted: true, rkey: input.rkey }));
