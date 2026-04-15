import { createHash } from 'crypto';

const APP_ID = 'hamlet-tiktok';
const APP_SECRET = process.env.LEGAL_APP_SECRET!;
const BASE_URL = 'https://legal.bytedance.net/compliance/api/external/v1';
const DEFAULT_LIAISON_ID = Number(process.env.DEFAULT_LIAISON_ID ?? '0');

export interface CreateTicketParams {
  featureName: string;
  workItemId: string;
  meegoUrl: string;
  prdUrl?: string;
  description?: string;
  priority?: string; // P0, P1, P2, P3
  liaisonId?: number; // employee number, falls back to DEFAULT_LIAISON_ID
}

export interface ComplianceResult {
  success: boolean;
  ticketUrl?: string;
  legalId?: number;
  error?: string;
}

// Map Hamlet priority to legal API priority: P0→1(P0), P1→2(P1), P2→3(P2), P3→3(P2)
function mapPriority(p?: string): string | undefined {
  const map: Record<string, string> = { P0: '1', P1: '2', P2: '3', P3: '3' };
  return p ? map[p] ?? undefined : undefined;
}

function sign(timestamp: string, bizParams: string): string {
  return createHash('md5').update(APP_SECRET + timestamp + bizParams).digest('hex');
}

/** Create a new compliance review ticket via /save */
export async function createComplianceTicket(params: CreateTicketParams): Promise<ComplianceResult> {
  const liaisonId = params.liaisonId ?? DEFAULT_LIAISON_ID;
  if (!liaisonId) {
    return { success: false, error: 'No projectLiaisonId (employee number) configured' };
  }

  const bizObj: Record<string, unknown> = {
    projectName: params.featureName,
    projectLiaisonId: liaisonId,
    businessEmpId: liaisonId,
    sourceBusinessId: params.workItemId,
    sourceLink: params.meegoUrl,
    reviewCategoryCode: '644', // Social
    productId: 3001, // TikTok
    affectedRegionsId: ['GLB'], // global
    verificationChargeEmpId: liaisonId,
    departmentId: process.env.DEPARTMENT_ID ?? '',
    isInitiate: false, // create as draft — questionnaire must be filled manually
  };

  const priority = mapPriority(params.priority);
  if (priority) bizObj.priority = priority;
  bizObj.featureOverview = params.description || params.featureName;
  if (params.prdUrl) bizObj.requirementDocLink = [params.prdUrl];

  const timestamp = String(Date.now());
  const bizParams = JSON.stringify(bizObj);

  try {
    const url = `${BASE_URL}/${APP_ID}/save`;
    const body = new URLSearchParams({ timestamp, sign: sign(timestamp, bizParams), bizParams }).toString();
    console.log(`[legal] POST ${url}`);
    console.log(`[legal] bizParams: ${bizParams.slice(0, 300)}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`[legal] Response status: ${res.status}`);
    const text = await res.text();
    console.log(`[legal] Response body: ${text.slice(0, 500)}`);

    const data = JSON.parse(text) as {
      success: boolean;
      code: string;
      msg: string;
      data?: { id?: number; detailUrl?: string; reviewStatus?: string };
    };

    if (data.success && data.data) {
      return {
        success: true,
        legalId: data.data.id,
        ticketUrl: data.data.detailUrl ?? (data.data.id ? `https://legal.bytedance.com/compliance/detail?id=${data.data.id}` : undefined),
      };
    }

    // Q00409 = draft created but validation failed — try to get the ticket URL
    if (data.code === 'Q00409') {
      const lookup = await getExistingTicket(params.workItemId);
      return {
        success: true,
        legalId: lookup.legalId,
        ticketUrl: lookup.ticketUrl,
        error: data.msg,
      };
    }

    return { success: false, error: `${data.code}: ${data.msg}` };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Check if a compliance ticket already exists for a Meego work item */
export async function getExistingTicket(workItemId: string): Promise<ComplianceResult> {
  const timestamp = String(Date.now());
  const bizParams = JSON.stringify({ workItemIds: [workItemId] });

  try {
    const res = await fetch(`${BASE_URL}/${APP_ID}/getByMeegoWorkItemId`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ timestamp, sign: sign(timestamp, bizParams), bizParams }).toString(),
      signal: AbortSignal.timeout(30_000),
    });

    const data = (await res.json()) as {
      success: boolean;
      data?: Array<{ workItemId: string; items?: Array<{ legalId: number; detailUrl: string }> }>;
    };

    if (data.success && data.data?.[0]?.items?.length) {
      const first = data.data[0].items[0];
      return { success: true, legalId: first.legalId, ticketUrl: first.detailUrl };
    }

    return { success: true }; // no existing ticket
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
