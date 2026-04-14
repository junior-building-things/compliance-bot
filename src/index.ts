import express from 'express';
import { sendReply, reactToMessage } from './lark.js';
import { createComplianceTicket, getExistingTicket } from './legal.js';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 9090);
const COMPLIANCE_CHAT_ID = 'oc_d1f9b0ad6b325ef6699e0422fa1e8541';

// Deduplicate events — Lark may retry
const seen = new Set<string>();
function isDuplicate(id: string): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  setTimeout(() => seen.delete(id), 5 * 60 * 1000);
  return false;
}

/** Parse the compliance card markdown to extract feature details */
function parseCardContent(raw: string): {
  featureName?: string;
  priority?: string;
  description?: string;
  meegoUrl?: string;
  prdUrl?: string;
  workItemId?: string;
} {
  const featureName = raw.match(/\*\*(?:Feature|Name):\*\*\s*(.+)/)?.[1]?.trim();
  const priority = raw.match(/\*\*Priority:\*\*\s*(P\d)/)?.[1];
  const description = raw.match(/\*\*Description:\*\*\s*(.+)/)?.[1]?.trim();
  const meegoUrl = raw.match(/\[(?:Open in Meego|Meego)\]\((https?:\/\/[^\)]+)\)/)?.[1];
  const prdUrl = raw.match(/\[(?:Open PRD|PRD)\]\((https?:\/\/[^\)]+)\)/)?.[1];
  const workItemId = meegoUrl?.match(/\/detail\/(\d+)/)?.[1];

  return { featureName, priority, description, meegoUrl, prdUrl, workItemId };
}

app.post('/webhook', async (req, res) => {
  const body = req.body as Record<string, unknown>;

  // URL verification challenge
  if (body.challenge) {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge immediately
  res.json({ ok: true });

  try {
    const header = body.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type as string | undefined;
    if (eventType !== 'im.message.receive_v1') return;

    const event = body.event as Record<string, unknown>;
    const message = event?.message as Record<string, unknown>;
    const messageId = message?.message_id as string;
    const chatId = message?.chat_id as string;
    const msgType = message?.message_type as string;

    // Only process messages in the compliance chat
    if (chatId !== COMPLIANCE_CHAT_ID) return;
    if (!messageId || isDuplicate(messageId)) return;
    if (msgType !== 'interactive') return;

    // Parse card content and header
    let content: string;
    let cardTitle = '';
    try {
      const parsed = JSON.parse(message.content as string);
      cardTitle = parsed.header?.title?.content ?? '';
      const elements = parsed.elements as Array<Record<string, unknown>> | undefined;
      content = elements?.map((e) => String(e.content ?? '')).join('\n') ?? '';
    } catch {
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
    await reactToMessage(messageId, 'OnIt');

    // Check if ticket already exists
    const existing = await getExistingTicket(card.workItemId);
    if (existing.ticketUrl) {
      await sendReply(messageId, `ℹ️ Compliance ticket already exists: ${existing.ticketUrl}`);
      await reactToMessage(messageId, 'DONE');
      return;
    }

    // Create new ticket
    const result = await createComplianceTicket({
      featureName: card.featureName ?? `Feature ${card.workItemId}`,
      workItemId: card.workItemId,
      meegoUrl: card.meegoUrl,
      prdUrl: card.prdUrl,
      description: card.description,
      priority: card.priority,
    });

    if (result.success && result.ticketUrl) {
      await sendReply(messageId, `✅ Compliance ticket created: ${result.ticketUrl}`);
      await reactToMessage(messageId, 'DONE');
    } else {
      await sendReply(messageId, `❌ Failed to create compliance ticket: ${result.error ?? 'Unknown error'}`);
      await reactToMessage(messageId, 'THUMBSDOWN');
    }
  } catch (err) {
    console.error('[compliance] Error:', err);
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Compliance bot listening on port ${PORT}`);
});
