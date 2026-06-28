export type OpsFlow = 'bluesky' | 'crucialTracks' | 'checkins' | 'popfeed' | 'ghostWebhook';
export type OpsOutcome = 'ok' | 'error' | 'skipped';

export interface OpsStatus {
  flow: OpsFlow;
  outcome: OpsOutcome;
  checkedAt: string;
  message: string;
  requestId?: string;
  summary?: Record<string, string | number | boolean | null>;
}

const OPS_PREFIX = 'ops:last:';

const FLOWS: OpsFlow[] = ['bluesky', 'crucialTracks', 'checkins', 'popfeed', 'ghostWebhook'];

function opsStore(platform: App.Platform | undefined): KVNamespace | undefined {
  return platform?.env?.CHECKINS_KV;
}

function safeValue(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null) return null;
  return undefined;
}

function actionCounts(value: unknown): Record<string, number> {
  if (!Array.isArray(value)) return {};

  return value.reduce<Record<string, number>>((counts, item) => {
    if (typeof item !== 'object' || item === null) return counts;
    const action = (item as { action?: unknown }).action;
    if (typeof action !== 'string' || !action) return counts;
    counts[`action.${action}`] = (counts[`action.${action}`] ?? 0) + 1;
    return counts;
  }, {});
}

export function summarizeResult(result: unknown): Record<string, string | number | boolean | null> {
  if (typeof result !== 'object' || result === null) return {};

  const object = result as Record<string, unknown>;
  const summary: Record<string, string | number | boolean | null> = {};

  [
    'source',
    'fetchedAt',
    'total',
    'totalFetched',
    'processed',
    'totalCanonical',
    'totalOverrides',
    'totalImportable',
    'pagesScanned',
    'offset',
    'nextOffset',
    'limit',
    'order',
    'tokenSource',
    'action',
    'postId',
    'slug',
    'uri',
    'cid',
    'verificationUpdated'
  ].forEach((key) => {
    const value = safeValue(object[key]);
    if (value !== undefined) summary[key] = value;
  });

  return { ...summary, ...actionCounts(object.results) };
}

export async function writeOpsStatus(
  platform: App.Platform | undefined,
  status: Omit<OpsStatus, 'checkedAt'>
): Promise<boolean> {
  const store = opsStore(platform);
  if (!store) return false;

  const record: OpsStatus = {
    ...status,
    checkedAt: new Date().toISOString()
  };

  try {
    await store.put(`${OPS_PREFIX}${status.flow}`, JSON.stringify(record));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown KV write error';
    console.warn(JSON.stringify({ message: 'operation status write failed', flow: status.flow, error: message }));
    return false;
  }
}

export async function readOpsStatuses(platform: App.Platform | undefined): Promise<{
  store: boolean;
  last: Record<OpsFlow, OpsStatus | null>;
}> {
  const store = opsStore(platform);
  const last = Object.fromEntries(FLOWS.map((flow) => [flow, null])) as Record<OpsFlow, OpsStatus | null>;

  if (!store) return { store: false, last };

  await Promise.all(FLOWS.map(async (flow) => {
    try {
      const raw = await store.get(`${OPS_PREFIX}${flow}`);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as OpsStatus;
        if (parsed.flow === flow && parsed.checkedAt && parsed.outcome) {
          last[flow] = parsed;
        }
      } catch {
        last[flow] = {
          flow,
          outcome: 'error',
          checkedAt: new Date().toISOString(),
          message: 'Stored status record is unreadable'
        };
      }
    } catch (error) {
      last[flow] = {
        flow,
        outcome: 'error',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? `Unable to read status record: ${error.message}` : 'Unable to read status record'
      };
    }
  }));

  return { store: true, last };
}
