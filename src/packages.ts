import {
  listActiveTikTokFeatures,
  fetchKanbanForMeego,
  pickLatestMergedByRole,
  translateMrId,
  fetchMrPackages,
  pickLatestMrPackage,
  MrPackage,
  KanbanItem,
} from './bits.js';

const JUNIOR_URL = process.env.JUNIOR_URL ?? 'https://junior-416594255546.asia-southeast1.run.app';
const CRON_SECRET = process.env.CRON_SECRET ?? '';

interface PlatformPackage {
  version: string;         // product version (e.g. "44.9.0") from the MR info if available
  qrUrl: string;           // iOS: itms-services install URL; Android: APK download URL
  downloadUrl: string;     // raw voffline URL (direct download)
  commitId?: string;
  packageName?: string;
}

function serialize(pkg: MrPackage | null, mr: KanbanItem, platform: 'android' | 'ios'): PlatformPackage | null {
  if (!pkg) return null;
  // For iOS, the QR encodes the itms-services:// install link so scanning on an
  // iPhone triggers the Install dialog. For Android, the APK URL works directly.
  const qrUrl = platform === 'ios' && pkg.install_url ? pkg.install_url : pkg.package_url;
  return {
    version: mr.release_info?.version ?? '',
    qrUrl,
    // `downloadUrl` is what Hamlet links to under the QR. Point at the Bits MR
    // page so PMs land on the MR (with all its build history) rather than an
    // opaque .ipa/.apk file.
    downloadUrl: mr.url || pkg.package_url,
    commitId: pkg.commit_id,
    packageName: pkg.package_name,
  };
}

async function resolvePlatformPackage(
  mr: KanbanItem | null,
  platform: 'android' | 'ios',
): Promise<PlatformPackage | null> {
  if (!mr) return null;
  const info = await translateMrId(mr.business_id);
  if (!info?.project_id || !info?.iid) return null;
  const groups = await fetchMrPackages(info.project_id, info.iid);
  const pkg = pickLatestMrPackage(groups, platform);
  return serialize(pkg, mr, platform);
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
        if (!androidMr && !iosMr) return;

        const [android, ios] = await Promise.all([
          resolvePlatformPackage(androidMr, 'android'),
          resolvePlatformPackage(iosMr, 'ios'),
        ]);
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
