import { getTenantToken, sendReply, reactToMessage } from './lark.js';
import { createComplianceTicket, getExistingTicket } from './legal.js';

const LARK_BASE_URL = process.env.LARK_BASE_URL ?? 'https://open.larkoffice.com';
const COMPLIANCE_CHAT_ID = 'oc_d1f9b0ad6b325ef6699e0422fa1e8541';
const POLL_INTERVAL = 60_000; // 60 seconds

// Track processed message IDs to avoid duplicates
const processed = new Set<string>();

/** Parse the compliance card markdown to extract feature details */
function parseCardContent(raw: string): {
  featureName?: string;
  priority?: string;
  description?: string;
  meegoUrl?: string;
  prdUrl?: string;
  workItemId?: string;
} {
  // Support both markdown format and plain text with URLs (Lark API returns the latter)
  const featureName = (raw.match(/\*\*(?:Feature|Name):\*\*\s*(.+)/)?.[1] ?? raw.match(/(?:Feature|Name):\s*(.+)/)?.[1])?.trim();
  const priority = (raw.match(/\*\*Priority:\*\*\s*(P\d)/)?.[1] ?? raw.match(/Priority:\s*(P\d)/)?.[1]);
  const description = (raw.match(/\*\*Description:\*\*\s*(.+)/)?.[1] ?? raw.match(/Description:\s*(.+)/)?.[1])?.trim();
  const meegoUrl = raw.match(/(https?:\/\/meego\.larkoffice\.com\/[^\s\)]+)/)?.[1];
  const prdUrl = raw.match(/(https?:\/\/bytedance\.sg\.larkoffice\.com\/[^\s\)]+)/)?.[1];
  const workItemId = meegoUrl?.match(/\/detail\/(\d+)/)?.[1];

  return { featureName, priority, description, meegoUrl, prdUrl, workItemId };
}

async function fetchRecentMessages(): Promise<Array<{ messageId: string; content: string }>> {
  const token = await getTenantToken();
  const res = await fetch(
    `${LARK_BASE_URL}/open-apis/im/v1/messages?container_id_type=chat&container_id=${COMPLIANCE_CHAT_ID}&page_size=20&sort_type=ByCreateTimeDesc`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json()) as {
    code: number;
    data?: { items?: Array<{ message_id: string; msg_type: string; body?: { content?: string } }> };
  };

  if (data.code !== 0) {
    console.error('[poll] Failed to fetch messages:', data);
    return [];
  }

  return (data.data?.items ?? [])
    .filter(m => m.msg_type === 'interactive')
    .map(m => ({ messageId: m.message_id, content: m.body?.content ?? '' }));
}

async function processMessage(messageId: string, content: string) {
  // Parse card header and content — Lark API returns a different format than what we send
  let cardTitle = '';
  let markdown = '';
  try {
    const parsed = JSON.parse(content);
    // Title can be at parsed.title or parsed.header.title.content
    cardTitle = parsed.title ?? parsed.header?.title?.content ?? '';
    // Elements can be nested arrays of {tag, text} or {tag, content}
    const elements = parsed.elements as Array<any> | undefined;
    // Also log raw elements for debugging
    console.log(`[parse] Raw elements: ${JSON.stringify(parsed.elements).slice(0, 1000)}`);
    if (elements) {
      const texts: string[] = [];
      for (const el of elements) {
        if (typeof el.content === 'string') {
          texts.push(el.content);
        } else if (Array.isArray(el)) {
          for (const sub of el) {
            if (sub.text) texts.push(sub.text);
            if (sub.href) texts.push(` ${sub.href} `);
          }
        }
      }
      markdown = texts.join('');
    }
  } catch {
    markdown = content;
  }

  console.log(`[process] Card title: "${cardTitle}", markdown: ${markdown.slice(0, 500)}`);

  if (!cardTitle.includes('PRD Ready')) {
    console.log(`[process] Skipping — not a PRD Ready card`);
    return;
  }

  const card = parseCardContent(markdown);
  if (!card.workItemId || !card.meegoUrl) {
    console.log(`[skip] No Meego work item ID in message ${messageId}`);
    return;
  }

  console.log(`[compliance] Processing: ${card.featureName} (${card.workItemId})`);
  console.log(`[compliance] Reacting...`);
  await reactToMessage(messageId, 'OnIt').catch(e => console.error('[compliance] React failed:', e));

  // Check if ticket already exists
  console.log(`[compliance] Checking existing ticket...`);
  const existing = await getExistingTicket(card.workItemId);
  if (existing.ticketUrl) {
    await sendReply(messageId, `ℹ️ Compliance ticket already exists: ${existing.ticketUrl}`);
    await reactToMessage(messageId, 'DONE');
    return;
  }

  console.log(`[compliance] Existing ticket check:`, JSON.stringify(existing));

  // Create new ticket
  console.log(`[compliance] Creating new ticket...`);
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
}

async function poll() {
  console.log(`[poll] Checking for new messages... (${processed.size} already processed)`);
  try {
    const messages = await fetchRecentMessages();
    console.log(`[poll] Fetched ${messages.length} messages`);
    let newCount = 0;
    for (const msg of messages) {
      if (processed.has(msg.messageId)) continue;
      newCount++;
      processed.add(msg.messageId);
      console.log(`[poll] New message: ${msg.messageId}`, msg.content.slice(0, 200));
      await processMessage(msg.messageId, msg.content);
    }
    if (newCount === 0) console.log('[poll] No new messages');
  } catch (err) {
    console.error('[poll] Error:', err);
  }
}

// Start polling
async function start() {
  console.log(`Compliance bot started (polling every ${POLL_INTERVAL / 1000}s)`);

  // First poll: mark existing messages as processed (don't act on old messages)
  try {
    const messages = await fetchRecentMessages();
    for (const msg of messages) {
      processed.add(msg.messageId);
    }
    console.log(`[init] Marked ${messages.length} existing messages as processed`);
  } catch (err) {
    console.error('[init] Error:', err);
  }

  // Start polling for new messages
  setInterval(poll, POLL_INTERVAL);
  console.log('[init] Polling started');
}

start();
