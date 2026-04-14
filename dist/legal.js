"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createComplianceTicket = createComplianceTicket;
exports.getExistingTicket = getExistingTicket;
const crypto_1 = require("crypto");
const APP_ID = 'hamlet-tiktok';
const APP_SECRET = process.env.LEGAL_APP_SECRET;
const BASE_URL = 'https://legal.bytedance.net/compliance/api/external/v1';
const DEFAULT_LIAISON_ID = Number(process.env.DEFAULT_LIAISON_ID ?? '0');
// Map Hamlet priority to legal API priority: P0→1(P0), P1→2(P1), P2→3(P2), P3→3(P2)
function mapPriority(p) {
    const map = { P0: '1', P1: '2', P2: '3', P3: '3' };
    return p ? map[p] ?? undefined : undefined;
}
function sign(timestamp, bizParams) {
    return (0, crypto_1.createHash)('md5').update(APP_SECRET + timestamp + bizParams).digest('hex');
}
/** Create a new compliance review ticket via /save */
async function createComplianceTicket(params) {
    const liaisonId = params.liaisonId ?? DEFAULT_LIAISON_ID;
    if (!liaisonId) {
        return { success: false, error: 'No projectLiaisonId (employee number) configured' };
    }
    const bizObj = {
        projectName: params.featureName,
        projectLiaisonId: liaisonId,
        businessEmpId: liaisonId,
        sourceBusinessId: params.workItemId,
        sourceLink: params.meegoUrl,
        reviewCategoryCode: '56', // product iteration
        isInitiate: true, // auto-submit
    };
    const priority = mapPriority(params.priority);
    if (priority)
        bizObj.priority = priority;
    if (params.description)
        bizObj.featureOverview = params.description;
    if (params.prdUrl)
        bizObj.requirementDocLink = [params.prdUrl];
    const timestamp = String(Date.now());
    const bizParams = JSON.stringify(bizObj);
    try {
        const res = await fetch(`${BASE_URL}/${APP_ID}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ timestamp, sign: sign(timestamp, bizParams), bizParams }).toString(),
        });
        const data = (await res.json());
        if (data.success && data.data) {
            return {
                success: true,
                legalId: data.data.id,
                ticketUrl: data.data.detailUrl,
            };
        }
        return { success: false, error: `${data.code}: ${data.msg}` };
    }
    catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
}
/** Check if a compliance ticket already exists for a Meego work item */
async function getExistingTicket(workItemId) {
    const timestamp = String(Date.now());
    const bizParams = JSON.stringify({ workItemIds: [workItemId] });
    try {
        const res = await fetch(`${BASE_URL}/${APP_ID}/getByMeegoWorkItemId`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ timestamp, sign: sign(timestamp, bizParams), bizParams }).toString(),
        });
        const data = (await res.json());
        if (data.success && data.data?.[0]?.items?.length) {
            const first = data.data[0].items[0];
            return { success: true, legalId: first.legalId, ticketUrl: first.detailUrl };
        }
        return { success: true }; // no existing ticket
    }
    catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
}
