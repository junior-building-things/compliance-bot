"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const lark_js_1 = require("./lark.js");
const legal_js_1 = require("./legal.js");
const app = (0, express_1.default)();
app.use(express_1.default.json());
const PORT = Number(process.env.PORT ?? 9090);
const COMPLIANCE_CHAT_ID = 'oc_d1f9b0ad6b325ef6699e0422fa1e8541';
// Deduplicate events — Lark may retry
const seen = new Set();
function isDuplicate(id) {
    if (seen.has(id))
        return true;
    seen.add(id);
    setTimeout(() => seen.delete(id), 5 * 60 * 1000);
    return false;
}
/** Parse the compliance card markdown to extract feature details */
function parseCardContent(raw) {
    const featureName = raw.match(/\*\*(?:Feature|Name):\*\*\s*(.+)/)?.[1]?.trim();
    const priority = raw.match(/\*\*Priority:\*\*\s*(P\d)/)?.[1];
    const description = raw.match(/\*\*Description:\*\*\s*(.+)/)?.[1]?.trim();
    const meegoUrl = raw.match(/\[(?:Open in Meego|Meego)\]\((https?:\/\/[^\)]+)\)/)?.[1];
    const prdUrl = raw.match(/\[(?:Open PRD|PRD)\]\((https?:\/\/[^\)]+)\)/)?.[1];
    const workItemId = meegoUrl?.match(/\/detail\/(\d+)/)?.[1];
    return { featureName, priority, description, meegoUrl, prdUrl, workItemId };
}
app.post('/webhook', async (req, res) => {
    const body = req.body;
    // URL verification challenge
    if (body.challenge) {
        return res.json({ challenge: body.challenge });
    }
    // Acknowledge immediately
    res.json({ ok: true });
    try {
        const header = body.header;
        const eventType = header?.event_type;
        if (eventType !== 'im.message.receive_v1')
            return;
        const event = body.event;
        const message = event?.message;
        const messageId = message?.message_id;
        const chatId = message?.chat_id;
        const msgType = message?.message_type;
        // Only process messages in the compliance chat
        if (chatId !== COMPLIANCE_CHAT_ID)
            return;
        if (!messageId || isDuplicate(messageId))
            return;
        if (msgType !== 'interactive')
            return;
        // Parse card content and header
        let content;
        let cardTitle = '';
        try {
            const parsed = JSON.parse(message.content);
            cardTitle = parsed.header?.title?.content ?? '';
            const elements = parsed.elements;
            content = elements?.map((e) => String(e.content ?? '')).join('\n') ?? '';
        }
        catch {
            content = String(message.content ?? '');
        }
        // Only create compliance tickets for "PRD Ready" cards
        if (!cardTitle.includes('PRD Ready')) {
            console.log(`[skip] Not a PRD Ready card: "${cardTitle}"`);
            return;
        }
        const card = parseCardContent(content);
        if (!card.workItemId || !card.meegoUrl) {
            console.log(`[skip] No Meego work item ID in message ${messageId}`);
            return;
        }
        console.log(`[compliance] Processing: ${card.featureName} (${card.workItemId})`);
        await (0, lark_js_1.reactToMessage)(messageId, 'OnIt');
        // Check if ticket already exists
        const existing = await (0, legal_js_1.getExistingTicket)(card.workItemId);
        if (existing.ticketUrl) {
            await (0, lark_js_1.sendReply)(messageId, `ℹ️ Compliance ticket already exists: ${existing.ticketUrl}`);
            await (0, lark_js_1.reactToMessage)(messageId, 'DONE');
            return;
        }
        // Create new ticket
        const result = await (0, legal_js_1.createComplianceTicket)({
            featureName: card.featureName ?? `Feature ${card.workItemId}`,
            workItemId: card.workItemId,
            meegoUrl: card.meegoUrl,
            prdUrl: card.prdUrl,
            description: card.description,
            priority: card.priority,
        });
        if (result.success && result.ticketUrl) {
            await (0, lark_js_1.sendReply)(messageId, `✅ Compliance ticket created: ${result.ticketUrl}`);
            await (0, lark_js_1.reactToMessage)(messageId, 'DONE');
        }
        else {
            await (0, lark_js_1.sendReply)(messageId, `❌ Failed to create compliance ticket: ${result.error ?? 'Unknown error'}`);
            await (0, lark_js_1.reactToMessage)(messageId, 'THUMBSDOWN');
        }
    }
    catch (err) {
        console.error('[compliance] Error:', err);
    }
});
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});
app.listen(PORT, () => {
    console.log(`Compliance bot listening on port ${PORT}`);
});
