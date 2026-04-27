import { getTenantToken, sendReply, reactToMessage } from './lark.js';
import { createComplianceTicket } from './legal.js';
import { uploadPerMeegoPackages } from './packages.js';

const LARK_BASE_URL = process.env.LARK_BASE_URL ?? 'https://open.larkoffice.com';
const COMPLIANCE_CHAT_ID = 'oc_d1f9b0ad6b325ef6699e0422fa1e8541';
const POLL_INTERVAL = 60_000; // 60 seconds
const PACKAGE_INTERVAL = 24 * 60 * 60 * 1000; // 24 h

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

async function fetchRecentMessages(): Promise<Array<{ messageId: string; content: string; msgType: string }>> {
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
    .filter(m => m.msg_type === 'interactive' || m.msg_type === 'text' || m.msg_type === 'post')
    .map(m => ({ messageId: m.message_id, content: m.body?.content ?? '', msgType: m.msg_type }));
}

async function processMessage(messageId: string, content: string, msgType: string) {
  // Two accepted formats:
  //   1. Interactive card with title "PRD Ready ✅" (sent by Junior or test script).
  //   2. Plain text message that mentions "PRD Ready" anywhere AND contains a Meego URL.
  let cardTitle = '';
  let markdown = '';

  if (msgType === 'text' || msgType === 'post') {
    // text body:  { "text": "..." }
    // post body:  { "title": "...", "content": [[{tag,text|href}, ...], ...] }
    try {
      const parsed = JSON.parse(content) as { text?: string; title?: string; content?: Array<Array<{ tag?: string; text?: string; href?: string }>> };
      if (parsed.text) {
        markdown = parsed.text;
      } else if (Array.isArray(parsed.content)) {
        const parts: string[] = [];
        if (parsed.title) parts.push(parsed.title);
        for (const line of parsed.content) {
          for (const seg of line) {
            if (seg.text) parts.push(seg.text);
            if (seg.href) parts.push(seg.href);
          }
          parts.push('\n');
        }
        markdown = parts.join(' ');
      }
    } catch { markdown = content; }

    if (!/PRD Ready/i.test(markdown)) {
      console.log(`[process] Skipping — ${msgType} without "PRD Ready"`);
      return;
    }
  } else {
    // Card
    try {
      const parsed = JSON.parse(content);
      cardTitle = parsed.title ?? parsed.header?.title?.content ?? '';
      const elements = parsed.elements as Array<any> | undefined;
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
  }

  const card = parseCardContent(markdown);
  if (!card.workItemId || !card.meegoUrl) {
    console.log(`[skip] No Meego work item ID in message ${messageId}`);
    return;
  }

  console.log(`[compliance] Processing: ${card.featureName} (${card.workItemId})`);
  console.log(`[compliance] Reacting...`);
  await reactToMessage(messageId, 'OnIt').catch(e => console.error('[compliance] React failed:', e));

  // Always create + submit a new ticket. Stale drafts on legal.bytedance.com
  // are common (test runs, prior manual attempts) — surfacing the existing
  // draft would block real submissions.
  console.log(`[compliance] Creating new ticket...`);
  const result = await createComplianceTicket({
    featureName: card.featureName ?? `Feature ${card.workItemId}`,
    workItemId: card.workItemId,
    meegoUrl: card.meegoUrl,
    prdUrl: card.prdUrl,
    description: card.description,
    priority: card.priority,
  });

  console.log(`[compliance] Ticket result:`, JSON.stringify(result));

  try {
    if (result.success && result.ticketUrl) {
      await sendReply(messageId, `✅ Compliance ticket created: ${result.ticketUrl}`);
      await reactToMessage(messageId, 'DONE');
    } else if (result.error?.includes('draft') || result.error?.includes('validate failed')) {
      const urlPart = result.ticketUrl ? `\nTicket: ${result.ticketUrl}` : '';
      await sendReply(messageId, `📝 Draft compliance ticket created — all fields pre-filled. Please review and click Submit.${urlPart}`);
      await reactToMessage(messageId, 'DONE');
    } else {
      await sendReply(messageId, `❌ Failed to create compliance ticket: ${result.error ?? 'Unknown error'}`);
      await reactToMessage(messageId, 'THUMBSDOWN');
    }
    console.log(`[compliance] Reply sent`);
  } catch (replyErr) {
    console.error(`[compliance] Reply failed:`, replyErr);
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
      await processMessage(msg.messageId, msg.content, msg.msgType);
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

  // Per-meego package fetcher: run on boot, then every 30 min
  uploadPerMeegoPackages();
  setInterval(uploadPerMeegoPackages, PACKAGE_INTERVAL);
  console.log(`[init] Package fetcher started (every ${PACKAGE_INTERVAL / 3_600_000} h)`);
}

start();
