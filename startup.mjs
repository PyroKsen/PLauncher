import { pathToFileURL } from 'url';

const DEFAULT_OWNER = 'PyroKsen';
const DEFAULT_REPO = 'VersionsPLauncher';
const DEFAULT_FILE_PATH = 'version.txt';
const DEFAULT_REF = 'main';
const DEFAULT_YANDEX_PUBLIC_URL = 'https://disk.yandex.ru/d/e0SlEg1MvKaydw';

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function buildRawUrl(owner, repo, ref, filePath) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

function parseLegacyVersions(text) {
  return {
    games: Object.fromEntries(
      text.split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const [key, ...rest] = line.split(':');
          return [key.trim(), { version: rest.join(':').trim() }];
        })
    )
  };
}

async function fetchRawText(owner, repo, filePath, ref) {
  const url = buildRawUrl(owner, repo, ref, filePath);
  const res = await fetch(url, { headers: { 'User-Agent': 'node-download-script' } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return await res.text();
}

async function fetchYandexPublicText(publicUrl) {
  const apiUrl = `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(publicUrl)}`;
  const metaRes = await fetch(apiUrl, { headers: { 'User-Agent': 'node-download-script' } });

  if (!metaRes.ok) {
    const err = new Error(`Yandex HTTP ${metaRes.status}`);
    err.status = metaRes.status;
    err.url = apiUrl;
    throw err;
  }

  const meta = await metaRes.json();
  if (!meta || typeof meta.href !== 'string') {
    const err = new Error('Yandex download href missing');
    err.url = apiUrl;
    throw err;
  }

  const fileRes = await fetch(meta.href, { headers: { 'User-Agent': 'node-download-script' } });
  if (!fileRes.ok) {
    const err = new Error(`Yandex download HTTP ${fileRes.status}`);
    err.status = fileRes.status;
    err.url = meta.href;
    throw err;
  }

  return await fileRes.text();
}

function parseManifestText(text, filePath) {
  const trimmed = text.trim();
  if (filePath.toLowerCase().endsWith('.json') || trimmed.startsWith('{')) {
    const manifest = JSON.parse(trimmed);
    if (!manifest || typeof manifest !== 'object' || !manifest.games || typeof manifest.games !== 'object') {
      throw new Error('Invalid manifest format');
    }
    return manifest;
  }

  return parseLegacyVersions(text);
}

function attachManifestSource(manifest, source, url) {
  Object.defineProperty(manifest, '__source', {
    value: source,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(manifest, '__sourceUrl', {
    value: url,
    enumerable: false,
    configurable: true
  });
  return manifest;
}

export async function fetchManifest(
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
  filePath = DEFAULT_FILE_PATH,
  ref = DEFAULT_REF,
  yandexPublicUrl = DEFAULT_YANDEX_PUBLIC_URL
) {
  try {
    return attachManifestSource(
      parseManifestText(await fetchRawText(owner, repo, filePath, ref), filePath),
      'github',
      buildRawUrl(owner, repo, ref, filePath)
    );
  } catch (err) {
    if (filePath === 'manifest.json' && err.status === 404) {
      try {
        return attachManifestSource(
          parseManifestText(await fetchRawText(owner, repo, 'version.txt', ref), 'version.txt'),
          'github',
          buildRawUrl(owner, repo, ref, 'version.txt')
        );
      } catch (fallbackErr) {
        if (!yandexPublicUrl) throw fallbackErr;
      }
    }

    if (!yandexPublicUrl) throw err;

    try {
      return attachManifestSource(
        parseManifestText(await fetchYandexPublicText(yandexPublicUrl), filePath),
        'yandex',
        yandexPublicUrl
      );
    } catch (yandexErr) {
      yandexErr.githubError = err;
      throw yandexErr;
    }
  }
}

const owner = process.argv[2] || DEFAULT_OWNER;
const repo = process.argv[3] || DEFAULT_REPO;
const filePath = process.argv[4] || DEFAULT_FILE_PATH;
const ref = getArg('--ref', DEFAULT_REF);
const yandexPublicUrl = getArg('--yandex-public-url', DEFAULT_YANDEX_PUBLIC_URL);

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const manifest = await fetchManifest(owner, repo, filePath, ref, yandexPublicUrl);
  console.log(JSON.stringify(manifest, null, 2));
}

export default fetchManifest;
