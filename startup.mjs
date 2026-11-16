import { pathToFileURL } from 'url';

const DEFAULT_OWNER = 'PyroKsen';
const DEFAULT_REPO = 'VersionsPLauncher';
const DEFAULT_FILE_PATH = 'version.txt';
const DEFAULT_REF = 'main';

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
  ref = DEFAULT_REF
) {
  let resolvedPath = filePath;
  let text;
  try {
    text = await fetchRawText(owner, repo, resolvedPath, ref);
  } catch (err) {
    if (filePath !== 'manifest.json' || err.status !== 404) throw err;
    resolvedPath = 'version.txt';
    text = await fetchRawText(owner, repo, resolvedPath, ref);
  }

  return attachManifestSource(
    parseManifestText(text, resolvedPath),
    'github',
    buildRawUrl(owner, repo, ref, resolvedPath)
  );
}

const owner = process.argv[2] || DEFAULT_OWNER;
const repo = process.argv[3] || DEFAULT_REPO;
const filePath = process.argv[4] || DEFAULT_FILE_PATH;
const ref = getArg('--ref', DEFAULT_REF);

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const manifest = await fetchManifest(owner, repo, filePath, ref);
  console.log(JSON.stringify(manifest, null, 2));
}

export default fetchManifest;
