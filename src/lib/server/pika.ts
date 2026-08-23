import type { SyncConfig } from './config.ts';
import { UpstreamError } from './http.ts';

export interface PikaPostInput {
  content: string;
  title?: string;
  categories?: string[];
  published?: string;
  status?: 'draft' | 'published';
  photos?: Array<string | { value: string; alt?: string }>;
}

export interface PikaPostResult {
  location: string;
  status: 'draft' | 'published';
}

function authorization(config: SyncConfig): HeadersInit {
  if (!config.pikaMicropubToken) throw new Error('Pika Micropub token is not configured');
  return { Authorization: `Bearer ${config.pikaMicropubToken}` };
}

async function pikaError(response: Response): Promise<never> {
  const text = await response.text();
  let detail = response.statusText || `HTTP ${response.status}`;
  try {
    const body = JSON.parse(text) as { error?: string; error_description?: string };
    detail = body.error_description || body.error || detail;
  } catch {
    if (text.trim()) detail = text.trim().slice(0, 300);
  }
  throw new UpstreamError(`Pika Micropub: ${detail}`, response.status);
}

export async function verifyPikaMicropub(config: SyncConfig): Promise<string> {
  const url = new URL(config.pikaMicropubEndpoint);
  url.searchParams.set('q', 'config');
  const response = await fetch(url, { headers: authorization(config) });
  if (!response.ok) return pikaError(response);
  const body = await response.json() as { 'media-endpoint'?: string };
  if (!body['media-endpoint']) throw new UpstreamError('Pika Micropub did not return a media endpoint', response.status);
  return body['media-endpoint'];
}

export async function createPikaPost(config: SyncConfig, input: PikaPostInput): Promise<PikaPostResult> {
  const content = input.content.trim();
  if (!content) throw new Error('Pika post content is required');
  const status = input.status ?? 'draft';
  const properties: Record<string, unknown[]> = {
    content: [content],
    'post-status': [status]
  };
  if (input.title?.trim()) properties.name = [input.title.trim()];
  if (input.categories?.length) properties.category = input.categories.map((value) => value.trim()).filter(Boolean);
  if (input.published) properties.published = [new Date(input.published).toISOString()];
  if (input.photos?.length) properties.photo = input.photos;

  const response = await fetch(config.pikaMicropubEndpoint, {
    method: 'POST',
    headers: { ...authorization(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: ['h-entry'], properties })
  });
  if (!response.ok) return pikaError(response);
  const location = response.headers.get('location');
  if (response.status !== 201 || !location) {
    throw new UpstreamError('Pika Micropub did not return a created post location', response.status);
  }
  return { location, status };
}
