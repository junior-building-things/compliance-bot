import { fetchLatestPackages, Artifact } from './bits.js';

const JUNIOR_URL = process.env.JUNIOR_URL ?? 'https://junior-416594255546.asia-southeast1.run.app';
const CRON_SECRET = process.env.CRON_SECRET ?? '';

function serialize(a: Artifact | null) {
  if (!a) return null;
  return {
    version: a.version_name,
    qrUrl: a.qr_code_url,
    downloadUrl: a.download_url,
    commitId: a.commit_id,
    branch: a.branch,
    channel: a.channel,
    artifactName: a.artifact_name,
  };
}

export async function uploadLatestPackages(): Promise<void> {
  if (!CRON_SECRET) {
    console.warn('[packages] CRON_SECRET not set, skipping upload');
    return;
  }
  try {
    const result = await fetchLatestPackages();
    if (!result.version) {
      console.log('[packages] No version found in any candidate, skipping');
      return;
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      version: result.version,
      android: serialize(result.android),
      ios: serialize(result.ios),
    };

    const res = await fetch(`${JUNIOR_URL}/api/packages/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error('[packages] Upload failed:', res.status, await res.text().catch(() => ''));
      return;
    }
    console.log(`[packages] Uploaded version=${payload.version} android=${payload.android?.version ?? 'none'} ios=${payload.ios?.version ?? 'none'}`);
  } catch (e) {
    console.error('[packages] Error:', e);
  }
}
