const BITS_BASE = 'https://bits.bytedance.net';
const BITS_SA_SECRET = process.env.BITS_SA_SECRET ?? process.env.BITS_TOKEN ?? '';
const IOS_APP_ID = Number(process.env.BITS_IOS_APP_ID ?? 118001);
const ANDROID_APP_ID = Number(process.env.BITS_ANDROID_APP_ID ?? 118002);
const TIKTOK_PROJECT_KEY = '5f105019a8b9a853da64767f';

async function bitsFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${BITS_SA_SECRET}` },
    signal: AbortSignal.timeout(15_000),
  });
}

// ─── Kanban: Meego ID → linked MRs / dev tasks / release tickets ────────────

export interface KanbanItem {
  business_type: 'merge_request' | 'bc21' | 'bc21_release_ticket' | string;
  business_id: number;
  title: string;
  url: string;
  state: string;          // 'merge' | 'close' | 'open' | 'finish' | ...
  stage: string;          // 'integration' | 'dev' | ...
  rd_role: string;        // 'Android' | 'iOS' | 'BE/FE' | 'ReleaseTicket'
  user?: { name?: string; avatar?: string };
  create_time: number;
  update_time: number;
  release_info?: {
    version?: string;
    url?: string;
    status?: string;
    is_gray?: boolean;
  };
}

export async function fetchKanbanForMeego(meegoId: string): Promise<KanbanItem[]> {
  const url = `${BITS_BASE}/openapi/meego_plugin/kanban/list?task_type=issue&task_id=${meegoId}`;
  const res = await bitsFetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { code: number; data?: KanbanItem[] };
  if (data.code !== 200 || !Array.isArray(data.data)) return [];
  return data.data;
}

/** For a given meego_id, return the latest-merged MR per platform along with
 *  its release_info.version (the Bits workflow version the MR landed in). */
export function pickLatestMergedByRole(items: KanbanItem[], rdRole: 'Android' | 'iOS'): KanbanItem | null {
  const candidates = items.filter(i =>
    i.business_type === 'merge_request' &&
    i.rd_role === rdRole &&
    i.state === 'merge' &&
    !!i.release_info?.version,
  );
  if (candidates.length === 0) return null;
  // Pick the one with the largest update_time (most recent activity).
  return candidates.reduce((best, c) =>
    !best || (c.update_time ?? 0) > (best.update_time ?? 0) ? c : best,
    null as KanbanItem | null,
  );
}

// ─── Workflow artifact lookup: version → APK/IPA ────────────────────────────

export interface Artifact {
  artifact_id: number;
  artifact_name: string;
  version_name: string;
  update_version: string;
  commit_id: string;
  branch: string;
  channel: string;
  download_url: string;
  qr_code_url: string;
  tags?: Record<string, string>;
}

interface Stage {
  stage_name: string;
  stage_status: string;
  artifacts?: Artifact[];
}

async function listWorkflowArtifacts(appId: number, version: string): Promise<Artifact[]> {
  const url = `${BITS_BASE}/api/v1/release/workflow/artifact/list?bits_app_id=${appId}&version=${encodeURIComponent(version)}&workflow_type=1&page_size=100`;
  const res = await bitsFetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { code: number; data?: Stage[] };
  if (data.code !== 200 || !Array.isArray(data.data)) return [];
  const all: Artifact[] = [];
  for (const stage of data.data) {
    if (stage.artifacts) all.push(...stage.artifacts);
  }
  return all;
}

function updateVersionNumber(a: Artifact): number {
  const n = Number(a.update_version);
  return Number.isFinite(n) ? n : 0;
}

/** Pick the "best" artifact: prefer the given channel, else the one with the highest update_version. */
function pickLatest(artifacts: Artifact[], preferredChannels: string[]): Artifact | null {
  if (artifacts.length === 0) return null;
  for (const ch of preferredChannels) {
    const pool = artifacts.filter(a => a.channel === ch);
    if (pool.length > 0) {
      return pool.reduce((best, a) =>
        !best || updateVersionNumber(a) > updateVersionNumber(best) ? a : best,
        null as Artifact | null,
      );
    }
  }
  return artifacts.reduce((best, a) =>
    !best || updateVersionNumber(a) > updateVersionNumber(best) ? a : best,
    null as Artifact | null,
  );
}

export async function fetchArtifactForPlatform(
  platform: 'android' | 'ios',
  version: string,
): Promise<Artifact | null> {
  const appId = platform === 'android' ? ANDROID_APP_ID : IOS_APP_ID;
  const artifacts = await listWorkflowArtifacts(appId, version);
  const preferred = platform === 'android'
    ? ['googleplay', 'huaweiadsglobal_int']
    : ['appstore', 'testflight', 'enterprise'];
  return pickLatest(artifacts, preferred);
}

// ─── Meego MCP: list active TikTok features ─────────────────────────────────

const MEEGO_MCP_URL = 'https://meego.larkoffice.com/mcp_server/v1';
const MEEGO_TOKEN = process.env.MEEGO_USER_TOKEN ?? '';

async function callMeegoMcp(toolName: string, args: Record<string, unknown>): Promise<string> {
  if (!MEEGO_TOKEN) throw new Error('MEEGO_USER_TOKEN not configured');
  const res = await fetch(MEEGO_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mcp-Token': MEEGO_TOKEN },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Meego MCP HTTP ${res.status}`);
  const data = (await res.json()) as { error?: { message: string }; result?: { content?: Array<{ text?: string }> } };
  if (data.error) throw new Error(`Meego MCP error: ${data.error.message}`);
  return data.result?.content?.[0]?.text ?? '';
}

/** List TikTok features owned by the current PM (token owner). */
export async function listActiveTikTokFeatures(): Promise<Array<{ workItemId: string; name: string }>> {
  const features: Array<{ workItemId: string; name: string }> = [];
  const MQL = "SELECT `work_item_id`, `name` FROM `TikTok`.`需求` WHERE `__PM` = current_login_user()";
  const GROUP_ID = '1';

  // Paged MQL loop (same pattern as Hamlet/Junior)
  let sessionId: string | undefined;
  let page = 1;
  while (true) {
    const args: Record<string, unknown> = sessionId
      ? { project_key: 'TikTok', session_id: sessionId, group_pagination_list: [{ group_id: GROUP_ID, page_num: page }] }
      : { project_key: 'TikTok', mql: MQL };
    const raw = await callMeegoMcp('search_by_mql', args);
    let data: {
      session_id?: string;
      list?: Array<{ count: number }>;
      data?: Record<string, Array<{
        moql_field_list: Array<{ key: string; value: { varchar_value?: string; long_value?: number } }>;
      }>>;
    };
    try { data = JSON.parse(raw); } catch { break; }
    if (!sessionId) sessionId = data.session_id;

    const total = data.list?.[0]?.count ?? 0;
    const items = data.data?.[GROUP_ID] ?? [];
    for (const item of items) {
      const id = item.moql_field_list.find(f => f.key === 'work_item_id')?.value.long_value;
      const name = item.moql_field_list.find(f => f.key === 'name')?.value.varchar_value ?? '';
      if (id) features.push({ workItemId: String(id), name });
    }
    if (features.length >= total || items.length === 0) break;
    page++;
  }
  return features;
}

export { TIKTOK_PROJECT_KEY };
