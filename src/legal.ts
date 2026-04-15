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

/** Build default questionnaire answers for a typical Social feature.
 *  Radio questions use answerCode as value, checkbox questions also use answerCode.
 *  Only include questions that are visible in the default flow. */
function buildDefaultQuestionnaire(featureDescription: string): Array<{ questionCode: string; type: string; value: string }> {
  return [
    // === Legal Review ===
    // Q1: Product functional requirements (radio)
    { questionCode: '3001:12:fa2b2f8a-e22e-43aa-8a1d-16e1d5dc8ff6', type: 'radio', value: 'b31c187c-74da-4216-842e-521317498934' },
    // Q2: Feature description (text)
    { questionCode: 'TikTok:ProductFeature:LegalReview:FeatureDesc:0', type: 'text', value: featureDescription },
    // Q3: None of the above involves (radio)
    { questionCode: '3001:413:d81b5974-869f-4693-b59a-c1e387f6f4e9', type: 'radio', value: 'b8892ca4-d335-49cc-9739-76d0708d2b6f' },
    // Q4: Yes, it is a new feature (radio)
    { questionCode: '3001:413:82b9a487-462e-4a0d-b9e1-fe52bbc85287', type: 'radio', value: '5a5a9a74-4e72-42d8-a2a9-d36bbc9e2c32' },
    // Q5: New feature but no new names/brands/logos (radio)
    { questionCode: '3001:413:76b84b55-8b3b-4b85-91cb-1d184afd67d7', type: 'radio', value: '6b418dd3-10d6-4c96-8799-a3cc99b73236' },
    // Q6: No — recommendation algorithm (radio)
    { questionCode: '3001:413:b4023a94-2dab-443a-ba02-b4cc3c768cc0', type: 'radio', value: '4f07d4a9-7eb8-46ce-b12d-a4fdc47a8805' },
    // Q7: Yes, deployed in US TTP with USDS coordination (radio)
    { questionCode: '3001:413:7d165cee-dc3d-4de4-907b-f436e5d4fb8a', type: 'radio', value: '1a6ce45a-83d6-4f01-a861-0a0aebf0d598' },
    // Q8: No, all US data remains in TTP (radio)
    { questionCode: '3001:413:2c9b2c96-1a8f-411a-a0fc-1775a31b5443', type: 'radio', value: 'e6a94773-8342-4be7-8e1b-ff4707fe0765' },
    // Q9: No third parties require access (radio)
    { questionCode: '3001:1:a5eb3d12-71a0-4052-a755-6c2c96379e16', type: 'radio', value: '037ae2bc-531d-4fcb-b872-95f68aee0a9a' },
    // Q10: No — payment (radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:FeaturePayment:0', type: 'radio', value: '541732b3-490f-4ea7-9148-19d346dfb729' },
    // Q11: No — third party data (radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:ThirdPartyData:0', type: 'radio', value: '5bd4a706-f998-4784-850e-66f7a786ddb7' },
    // Q12: None of above — user experiences (checkbox as radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:UserExperiences:0', type: 'radio', value: '以上都不涉及||none of above' },
    // Q13: No — collect new data (radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:CollectData:0', type: 'radio', value: '96f75ef6-eaee-4714-9da8-46626d8ad53a' },
    // Q14: None of the above — visible to users (checkbox as radio)
    { questionCode: '3001:411:c9ab2708-dfb5-4a79-b831-76d9ae41ee5e', type: 'radio', value: '以上场景均不涉及（例如仅为新入口、结构调整等）||None of the above (e.g. new entrance, structure adjustment, etc.)' },
    // Q15: No, won't need previously collected data (checkbox as radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:UseDataDetail:0', type: 'radio', value: '不需要，这个功能不需要使用任何之前收集的用户数据。||No, this feature won\'t need to use any previously collected data.' },
    // Q16: No — new purpose for data (radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:NewPurpose:0', type: 'radio', value: 'b2efcaa1-c590-4c42-b4be-9d1ab42c54c6' },
    // Q17: No — China access to L4 data (radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:ChinaAccess:0', type: 'radio', value: '3924b0c5-3ac8-4b99-8ef9-653203942ca0' },
    // Q18: No — share with third parties (radio)
    { questionCode: 'TikTok:ProductFeature:LegalReview:ShareDataWithThirdParty:0', type: 'radio', value: '5ee7dbac-38e7-4b69-984e-c8777f2a30d6' },

    // === T&S Review ===
    // Q19: No — content assurance (radio)
    { questionCode: 'TikTok:ProductFeature:TnsReview:NewContent:0', type: 'radio', value: 'cee9e9a6-7b46-4696-a14b-c31151b04551' },
    // Q20: Yes — underage users (radio)
    { questionCode: '3001:1:e2d4e425-0c60-410e-98bc-a00f8ea361aa', type: 'radio', value: '839e6c18-0968-47ee-a82b-727fb3f8fde3' },

    // === Security & Others Review ===
    // Q21: None of the above — scenario changes (checkbox as radio)
    { questionCode: 'TikTok:ProductFeature:SecurityReview:ScenarioChange:0', type: 'radio', value: '不涉及以上任何一项相关的情况||None of the above' },

    // === iOS Review ===
    // Q22: Yes — faces iOS users (radio)
    { questionCode: 'TikTok:CoreFeature:AppStore:ios:0', type: 'radio', value: 'ddd15c21-c506-4ede-b7fc-a24e79676f5a' },
    // Q23: None of the above involves (checkbox as radio)
    { questionCode: 'TikTok:CoreFeature:AppStore:FeatureChange:0', type: 'radio', value: '以上均不涉及||None of the above involves' },
  ];
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
    departmentId: process.env.DEPARTMENT_ID ?? '288980000065031987',
    isInitiate: true, // auto-submit with questionnaire
  };

  const priority = mapPriority(params.priority);
  if (priority) bizObj.priority = priority;
  const featureOverview = params.description || params.featureName;
  bizObj.featureOverview = featureOverview;
  bizObj.questionnaire = buildDefaultQuestionnaire(featureOverview);
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
