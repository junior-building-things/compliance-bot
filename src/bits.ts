const BITS_BASE = 'https://bits.bytedance.net';
const BITS_TOKEN = process.env.BITS_TOKEN!;
const IOS_APP_ID = Number(process.env.BITS_IOS_APP_ID ?? 118001);
const ANDROID_APP_ID = Number(process.env.BITS_ANDROID_APP_ID ?? 118002);

// Candidate versions to probe, highest first. Bits has no version-listing
// endpoint, so we try each in turn and use the first one with artifacts.
const CANDIDATE_VERSIONS = (process.env.BITS_CANDIDATE_VERSIONS ??
  '45.0.0,44.0.0,43.0.0,42.0.0,41.0.0,40.0.0'
).split(',').map(s => s.trim()).filter(Boolean);

export interface Artifact {
  artifact_id: number;
  artifact_name: string;
  version_name: string;
  update_version: string;
  commit_id: string;
  branch: string;
  channel: string;
  download_url: string;
  qr_code_url: string;
  tags?: Record<string, string>;
}

interface Stage {
  stage_name: string;
  stage_status: string;
  artifacts?: Artifact[];
}

async function listArtifacts(appId: number, version: string): Promise<Artifact[]> {
  const url = `${BITS_BASE}/api/v1/release/workflow/artifact/list?bits_app_id=${appId}&version=${version}&workflow_type=1&page_size=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BITS_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { code: number; data?: Stage[] };
  if (data.code !== 200 || !Array.isArray(data.data)) return [];
  const all: Artifact[] = [];
  for (const stage of data.data) {
    if (stage.artifacts) all.push(...stage.artifacts);
  }
  return all;
}

function updateVersionNumber(a: Artifact): number {
  const n = Number(a.update_version);
  return Number.isFinite(n) ? n : 0;
}

/** Pick the best artifact: prefer given channel, then highest update_version. */
function pickLatest(artifacts: Artifact[], preferredChannels: string[]): Artifact | null {
  if (artifacts.length === 0) return null;
  for (const ch of preferredChannels) {
    const pool = artifacts.filter(a => a.channel === ch);
    if (pool.length > 0) {
      return pool.reduce((best, a) =>
        !best || updateVersionNumber(a) > updateVersionNumber(best) ? a : best,
        null as Artifact | null,
      );
    }
  }
  // Fallback to all artifacts
  return artifacts.reduce((best, a) =>
    !best || updateVersionNumber(a) > updateVersionNumber(best) ? a : best,
    null as Artifact | null,
  );
}

export interface LatestPackages {
  version: string | null;
  android: Artifact | null;
  ios: Artifact | null;
}

/** Walk candidate versions from newest to oldest, return packages for the first version with data. */
export async function fetchLatestPackages(): Promise<LatestPackages> {
  for (const version of CANDIDATE_VERSIONS) {
    const android = await listArtifacts(ANDROID_APP_ID, version);
    if (android.length === 0) continue;
    const ios = await listArtifacts(IOS_APP_ID, version);
    return {
      version,
      android: pickLatest(android, ['googleplay', 'huaweiadsglobal_int']),
      ios: pickLatest(ios, ['appstore', 'testflight', 'enterprise']),
    };
  }
  return { version: null, android: null, ios: null };
}
