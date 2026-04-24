const BITS_BASE = 'https://bits.bytedance.net';
const CLOUD_JWT_URL = 'https://cloud.bytedance.net/auth/api/v1/jwt';
const BITS_SA_SECRET = process.env.BITS_SA_SECRET ?? '';
const TIKTOK_PROJECT_KEY = '5f105019a8b9a853da64767f';

// ─── JWT management ─────────────────────────────────────────────────────────
// Service account secret → JWT (returned in x-jwt-token header). JWT is valid
// for ~1h. Fetch lazily and cache until close to expiry.

let cachedJwt = '';
let jwtExpiresAt = 0;

function decodeJwtExp(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8')) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch { return 0; }
}

async function getJwt(): Promise<string> {
  if (cachedJwt && Date.now() < jwtExpiresAt - 60_000) return cachedJwt;
  if (!BITS_SA_SECRET) throw new Error('BITS_SA_SECRET not configured');

  const res = await fetch(CLOUD_JWT_URL, {
    headers: { Authorization: `Bearer ${BITS_SA_SECRET}` },
    signal: AbortSignal.timeout(10_000),
  });
  const jwt = res.headers.get('x-jwt-token');
  if (!jwt) throw new Error(`JWT exchange failed (HTTP ${res.status})`);
  cachedJwt = jwt;
  jwtExpiresAt = decodeJwtExp(jwt) || Date.now() + 50 * 60 * 1000;
  return jwt;
}

async function bitsJson<T>(path: string): Promise<T | null> {
  const jwt = await getJwt();
  const res = await fetch(`${BITS_BASE}${path}`, {
    headers: { 'x-jwt-token': jwt },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  try { return (await res.json()) as T; } catch { return null; }
}

// ─── Kanban: Meego ID → linked MRs / dev tasks / release tickets ────────────

export interface KanbanItem {
  business_type: 'merge_request' | 'bc21' | 'bc21_release_ticket' | string;
  business_id: number;     // devops-scheme MR id (used in the /devops/.../code/detail/<id> URL)
  title: string;
  url: string;
  state: string;           // 'merge' | 'close' | 'open' | 'finish' | ...
  stage: string;
  rd_role: string;         // 'Android' | 'iOS' | 'BE/FE' | 'ReleaseTicket'
  create_time: number;
  update_time: number;
  release_info?: { version?: string; url?: string; status?: string; is_gray?: boolean };
}

export async function fetchKanbanForMeego(meegoId: string): Promise<KanbanItem[]> {
  const data = await bitsJson<{ code: number; data?: KanbanItem[] }>(
    `/openapi/meego_plugin/kanban/list?task_type=issue&task_id=${meegoId}`,
  );
  if (data?.code !== 200 || !Array.isArray(data.data)) return [];
  return data.data;
}

/** Latest merged MR for a given platform. */
export function pickLatestMergedByRole(items: KanbanItem[], rdRole: 'Android' | 'iOS'): KanbanItem | null {
  const candidates = items.filter(i =>
    i.business_type === 'merge_request' && i.rd_role === rdRole && i.state === 'merge',
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) =>
    !best || (c.update_time ?? 0) > (best.update_time ?? 0) ? c : best,
    null as KanbanItem | null,
  );
}

// ─── MR translation: devops mr_id → { project_id, mr_iid } ─────────────────

interface MrInfo {
  iid?: number;
  project_id?: number;
  title?: string;
  state?: string;
}

export async function translateMrId(devopsMrId: number): Promise<MrInfo | null> {
  const data = await bitsJson<{ code?: number; status?: number; data?: MrInfo }>(
    `/openapi/merge_request/info?mr_id=${devopsMrId}`,
  );
  return data?.data ?? null;
}

// ─── MR packages: project_id + mr_iid → build artifacts ────────────────────

export interface MrArtifact {
  type: string;
  name: string;
  url: string;
}

export interface MrPackage {
  id: number;
  package_name: string;      // 'MusicallyInhouseRelease' | 'TikTokInhouseRelease' | ...
  package_url: string;       // raw voffline download
  install_url?: string;      // itms-services:// for iOS (use this for the QR)
  commit_id: string;
  create_time: number;
  update_time: number;
  artifacts?: MrArtifact[];
}

interface MrPackageGroup {
  id: number;
  packages: MrPackage[];
  create_time: number;
}

export async function fetchMrPackages(projectId: number, mrIid: number): Promise<MrPackageGroup[]> {
  const data = await bitsJson<{ code: number; data?: MrPackageGroup[] }>(
    `/api/mr_package/get_packages?project_id=${projectId}&mr_iid=${mrIid}&need_task=true`,
  );
  if (data?.code !== 200 || !Array.isArray(data.data)) return [];
  return data.data;
}

/** Pick the latest package matching the preferred platform build name.
 *  For iOS, we prefer the Musically bundle (the actual US/intl TikTok IPA). */
export function pickLatestMrPackage(
  groups: MrPackageGroup[],
  platform: 'android' | 'ios',
): MrPackage | null {
  if (groups.length === 0) return null;
  // Most recent build group first
  const sorted = [...groups].sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0));
  const preferredNames = platform === 'ios'
    ? ['MusicallyInhouseRelease', 'TikTokInhouseRelease']
    : ['TikTokInhouseRelease', 'MusicallyInhouseRelease'];
  for (const group of sorted) {
    if (!group.packages || group.packages.length === 0) continue;
    for (const name of preferredNames) {
      const match = group.packages.find(p => p.package_name === name && p.package_url);
      if (match) return match;
    }
    // Fallback: any package with a URL
    const any = group.packages.find(p => p.package_url);
    if (any) return any;
  }
  return null;
}

// ─── Meego MCP: list TikTok features ────────────────────────────────────────

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

export async function listActiveTikTokFeatures(): Promise<Array<{ workItemId: string; name: string }>> {
  const features: Array<{ workItemId: string; name: string }> = [];
  const MQL = "SELECT `work_item_id`, `name` FROM `TikTok`.`需求` WHERE `__PM` = current_login_user()";
  const GROUP_ID = '1';

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
