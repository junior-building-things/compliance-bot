import {
  listActiveTikTokFeatures,
  fetchKanbanForMeego,
  pickLatestMergedByRole,
  fetchArtifactForPlatform,
  Artifact,
} from './bits.js';

const JUNIOR_URL = process.env.JUNIOR_URL ?? 'https://junior-416594255546.asia-southeast1.run.app';
const CRON_SECRET = process.env.CRON_SECRET ?? '';

interface PlatformPackage {
  version: string;
  qrUrl: string;
  downloadUrl: string;
  commitId?: string;
  channel?: string;
}

function serialize(a: Artifact | null): PlatformPackage | null {
  if (!a) return null;
  return {
    version: a.version_name,
    qrUrl: a.qr_code_url,
    downloadUrl: a.download_url,
    commitId: a.commit_id,
    channel: a.channel,
  };
}

export async function uploadPerMeegoPackages(): Promise<void> {
  if (!CRON_SECRET) {
    console.warn('[packages] CRON_SECRET not set, skipping upload');
    return;
  }

  let features;
  try {
    features = await listActiveTikTokFeatures();
  } catch (e) {
    console.error('[packages] Failed to list features:', e);
    return;
  }
  console.log(`[packages] Listing ${features.length} TikTok features`);

  const out: Record<string, { android: PlatformPackage | null; ios: PlatformPackage | null }> = {};
  let found = 0;

  // Process all features; kanban naturally returns empty for pre-dev ones.
  // Batch to avoid hammering Bits but still finish in reasonable time.
  const BATCH = 5;
  let processed = 0;
  for (let i = 0; i < features.length; i += BATCH) {
    const batch = features.slice(i, i + BATCH);
    await Promise.all(batch.map(async (f) => {
      try {
        const items = await fetchKanbanForMeego(f.workItemId);
        if (items.length === 0) return;

        const androidMr = pickLatestMergedByRole(items, 'Android');
        const iosMr = pickLatestMergedByRole(items, 'iOS');
        const aVer = androidMr?.release_info?.version;
        const iVer = iosMr?.release_info?.version;
        if (!aVer && !iVer) return;

        const [androidArt, iosArt] = await Promise.all([
          aVer ? fetchArtifactForPlatform('android', aVer) : Promise.resolve(null),
          iVer ? fetchArtifactForPlatform('ios',     iVer) : Promise.resolve(null),
        ]);

        const android = serialize(androidArt);
        const ios = serialize(iosArt);
        if (android || ios) {
          out[f.workItemId] = { android, ios };
          found++;
        }
      } catch (e) {
        console.error(`[packages] Feature ${f.workItemId} (${f.name}) failed:`, e);
      }
    }));
    processed += batch.length;
    if (processed % 25 === 0) console.log(`[packages] Progress: ${processed}/${features.length} (${found} with packages so far)`);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    features: out,
  };

  try {
    const res = await fetch(`${JUNIOR_URL}/api/packages/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON_SECRET}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error('[packages] Upload failed:', res.status, await res.text().catch(() => ''));
      return;
    }
    console.log(`[packages] Uploaded packages for ${found}/${features.length} features`);
  } catch (e) {
    console.error('[packages] Upload error:', e);
  }
}
