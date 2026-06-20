export class UpstreamError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
  }
}

export async function readJsonResponse<T>(response: Response, service: string): Promise<T> {
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new UpstreamError(`${service} returned invalid JSON`, response.status);
  }
  if (!response.ok) {
    const object = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const code = typeof object.error === 'string' ? object.error : undefined;
    const detail = typeof object.message === 'string' ? object.message : response.statusText;
    throw new UpstreamError(`${service}: ${detail}`, response.status, code);
  }
  return value as T;
}
