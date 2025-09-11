const [,, owner = 'PyroKsen', repo = 'VersionsPLauncher', filePath = 'version.txt'] = process.argv;
const ref = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : 'main';

const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;

const res = await fetch(url, { headers: { 'User-Agent': 'node-download-script' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const text = await res.text();

const parsed = Object.fromEntries(
    text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    const num = Number(v);
    return [k.trim(), Number.isNaN(num) ? v : num];
    })
);
console.log(parsed)
export default parsed