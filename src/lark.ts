const LARK_BASE_URL = process.env.LARK_BASE_URL ?? 'https://open.larkoffice.com';
const LARK_APP_ID = process.env.LARK_APP_ID!;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET!;

let cachedToken = '';
let tokenExpiresAt = 0;

export async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const res = await fetch(`${LARK_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
  });
  const data = (await res.json()) as { tenant_access_token: string; expire?: number };
  cachedToken = data.tenant_access_token;
  tokenExpiresAt = Date.now() + (data.expire ?? 7200) * 1000;
  return cachedToken;
}

export async function sendReply(messageId: string, text: string): Promise<void> {
  const token = await getTenantToken();
  await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
}

export async function reactToMessage(messageId: string, emoji: string): Promise<void> {
  const token = await getTenantToken();
  await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages/${messageId}/reactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
  }).catch(() => {});
}
