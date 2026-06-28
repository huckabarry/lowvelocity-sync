const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Expected an even-length hexadecimal value');
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

export async function createGhostAdminToken(apiKey: string, now = Date.now()): Promise<string> {
  const [id, secretHex, extra] = apiKey.split(':');
  if (!id || !secretHex || extra) throw new Error('Ghost Admin API key has an invalid format');
  const issuedAt = Math.floor(now / 1000);
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', kid: id, typ: 'JWT' })));
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 300, aud: '/admin/' })));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('raw', bufferSource(hexToBytes(secretHex)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, bufferSource(encoder.encode(unsigned))));
  return `${unsigned}.${bytesToBase64Url(signature)}`;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let mismatch = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

export interface GhostSignature {
  digest: Uint8Array;
  timestamp: string;
}

export function parseGhostSignature(header: string): GhostSignature | null {
  let digestHex = '';
  let timestamp = '';
  for (const part of header.split(',').map((value) => value.trim())) {
    if (part.toLowerCase().startsWith('sha256=')) digestHex = part.slice(7);
    if (part.startsWith('t=')) timestamp = part.slice(2);
  }
  if (!digestHex || !/^\d+$/.test(timestamp)) return null;
  try {
    return { digest: hexToBytes(digestHex), timestamp };
  } catch {
    return null;
  }
}

export async function verifyGhostSignature(body: Uint8Array, header: string, secret: string, now = Date.now()): Promise<boolean> {
  const parsed = parseGhostSignature(header);
  if (!parsed) return false;
  const timestampNumber = Number(parsed.timestamp);
  const timestampMs = timestampNumber > 1_000_000_000_000 ? timestampNumber : timestampNumber * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 15 * 60 * 1000) return false;
  const timestamp = encoder.encode(parsed.timestamp);
  const signed = new Uint8Array(body.byteLength + timestamp.byteLength);
  signed.set(body);
  signed.set(timestamp, body.byteLength);
  const key = await crypto.subtle.importKey('raw', bufferSource(encoder.encode(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (await crypto.subtle.verify('HMAC', key, bufferSource(parsed.digest), bufferSource(signed))) return true;
  // Ghost installations have emitted both timestamp-bound and body-only
  // signatures. The timestamp freshness check above still prevents replay.
  return crypto.subtle.verify('HMAC', key, bufferSource(parsed.digest), bufferSource(body));
}
