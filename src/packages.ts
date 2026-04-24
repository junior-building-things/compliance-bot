import {
  listActiveTikTokFeatures,
  fetchKanbanForMeego,
  pickLatestMergedByRole,
  fetchArtifactForPlatform,
  Artifact,
} from './bits.js';

const JUNIOR_URL = process.env.JUNIOR_URL ?? 'https://junior-416594255546.asia-southeast1.run.app';
const CRON_SECRET = process.env.CRON_SECRET ?? '';

// Meego statuses where a Bits dev task / MR is expected to exist.
// Status keys come from Meego `work_item_status.key` — we keep this inclusive
// because statuses vary across projects.
const HAS_CODE_STATUS_KEYS = new Set([
  'development',
  'development_started',
  'development_completed',
  'development_ing',
  'development_done',
  'test',
  'testing',
  'ab_test',
  'grey_release',
  'full_release',
  'online',
  'done',
  'released',
]);

function hasCode(statusKey: string): boolean {
  if (!statusKey) return false;
  const k = statusKey.toLowerCase();
  if (HAS_CODE_STATUS_KEYS.has(k)) return true;
  // Heuristic fallback: include anything that looks dev/QA/AB/launched
  return /dev|test|ab|grey|launch|release|online|merg|qa|uat/.test(k);
}

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

  // Serial to avoid hammering Bits; could parallelise in small batches later.
  for (const f of features) {
    if (!hasCode(f.status)) continue;
    try {
      const items = await fetchKanbanForMeego(f.workItemId);
      const androidMr = pickLatestMergedByRole(items, 'Android');
      const iosMr = pickLatestMergedByRole(items, 'iOS');

      const [androidArt, iosArt] = await Promise.all([
        androidMr?.release_info?.version ? fetchArtifactForPlatform('android', androidMr.release_info.version) : Promise.resolve(null),
        iosMr?.release_info?.version ? fetchArtifactForPlatform('ios', iosMr.release_info.version) : Promise.resolve(null),
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
