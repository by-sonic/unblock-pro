#!/usr/bin/env node
'use strict';

// Moves the upstream pins forward to the newest upstream release, the way a
// maintainer would by hand:
//
//   Windows — Flowseal/zapret-discord-youtube latest release: download the zip,
//             check it against the SHA-256 GitHub publishes for the asset,
//             check the archive's bin/ against the tagged source tree, then
//             rewrite flowseal-bundle.js and re-run sync-flowseal-strategies.js.
//   macOS   — bol-van/zapret master: re-pin ZAPRET_MACOS_COMMIT, but only when
//             something under tpws/ changed (nfqws-only commits do not reach
//             the macOS runtime, so they are not worth a release).
//
// It only edits files in this checkout. Nothing is fetched by the app at run
// time; the result is reviewed and tested as a normal PR
// (.github/workflows/upstream-update.yml).
//
//   node scripts/update-upstream.js [--summary <file>] [--check]
//
// --check reports what would change and exits 0 without touching files.
// GITHUB_TOKEN / GH_TOKEN, when set, raises the API rate limit.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const FLOWSEAL_REPO = 'Flowseal/zapret-discord-youtube';
const ZAPRET_REPO = 'bol-van/zapret';
const ZAPRET_BRANCH = 'master';
const CORE_WINDOWS_FILES = ['winws.exe', 'WinDivert.dll', 'WinDivert64.sys', 'cygwin1.dll'];

const repoRoot = path.join(__dirname, '..');
const bundlePath = path.join(repoRoot, 'src', 'main', 'flowseal-bundle.js');
const zapretSourcePath = path.join(repoRoot, 'src', 'main', 'zapret-source.js');
const readmePath = path.join(repoRoot, 'README.md');

function parseArgs(argv) {
  const options = { check: false, summary: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') options.check = true;
    else if (argv[i] === '--summary') options.summary = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

async function request(url, { json = true } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { 'User-Agent': 'unblock-pro-upstream-update' };
  if (json) headers.Accept = 'application/vnd.github+json';
  if (token && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return json ? response.json() : Buffer.from(await response.arrayBuffer());
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Minimal reader for the archive's central directory: enough to list entries
// and inflate the stored/deflated ones. Avoids a dependency for one check.
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported zip method ${method} for ${name}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function orderWindowsFiles(files) {
  const missingCore = CORE_WINDOWS_FILES.filter((file) => !files.includes(file));
  if (missingCore.length) throw new Error(`Flowseal archive is missing ${missingCore.join(', ')}`);
  return [...CORE_WINDOWS_FILES, ...files.filter((file) => !CORE_WINDOWS_FILES.includes(file)).sort()];
}

function replaceOnce(text, pattern, replacement, what) {
  if (!pattern.test(text)) throw new Error(`Could not find ${what}`);
  return text.replace(pattern, replacement);
}

async function checkFlowseal(work) {
  const bundle = require(bundlePath);
  const pinned = bundle.FLOWSEAL_BUNDLE_VERSION;
  const latest = await request(`https://api.github.com/repos/${FLOWSEAL_REPO}/releases/latest`);
  const tag = latest.tag_name;
  const result = { name: 'Flowseal (Windows)', pinned, latest: tag, changed: false, notes: [] };
  if (tag === pinned) return result;

  const pinnedRelease = await request(`https://api.github.com/repos/${FLOWSEAL_REPO}/releases/tags/${encodeURIComponent(pinned)}`)
    .catch(() => null);
  if (pinnedRelease && new Date(latest.published_at) <= new Date(pinnedRelease.published_at)) {
    result.notes.push(`Upstream "latest" (${tag}) is not newer than the pin (${pinned}); left as is.`);
    return result;
  }

  const assetName = `zapret-discord-youtube-${tag}.zip`;
  const asset = (latest.assets || []).find((candidate) => candidate.name === assetName);
  if (!asset) throw new Error(`Flowseal ${tag} has no ${assetName} asset`);
  const archive = await request(asset.browser_download_url, { json: false });
  const archiveSha = sha256(archive);
  if (!asset.digest) throw new Error(`GitHub publishes no digest for ${assetName}; refusing to pin an unverifiable archive`);
  if (asset.digest !== `sha256:${archiveSha}`) {
    throw new Error(`${assetName}: downloaded sha256 ${archiveSha} does not match published ${asset.digest}`);
  }

  // The tagged tree is what the strategy/list snapshots are generated from, so
  // the archive has to carry exactly the same bin/ files as that tree.
  const gitDir = path.join(work, 'flowseal.git');
  git(['init', '--quiet', '--bare', gitDir]);
  git(['--git-dir', gitDir, 'fetch', '--quiet', '--depth', '1', '--no-tags',
    `https://github.com/${FLOWSEAL_REPO}.git`, `+refs/tags/${tag}:refs/tags/${tag}`]);
  const commit = git(['--git-dir', gitDir, 'rev-parse', `refs/tags/${tag}^{commit}`]).trim();
  const version = git(['--git-dir', gitDir, 'show', `${commit}:.service/version.txt`]).trim();
  if (version !== tag) throw new Error(`Flowseal ${tag}: .service/version.txt says ${version}`);

  const prefix = `zapret-discord-youtube-${tag}/bin/`;
  const zip = readZip(archive);
  const archiveFiles = [...zip.keys()].filter((name) => name.startsWith(prefix) && !name.endsWith('/'))
    .map((name) => name.slice(prefix.length));
  if (archiveFiles.some((name) => name.includes('/'))) throw new Error(`${assetName}: unexpected subdirectory under bin/`);
  const treeFiles = git(['--git-dir', gitDir, 'ls-tree', '--name-only', `${commit}:bin`]).split('\n').filter(Boolean);
  const onlyArchive = archiveFiles.filter((name) => !treeFiles.includes(name));
  const onlyTree = treeFiles.filter((name) => !archiveFiles.includes(name));
  if (onlyArchive.length || onlyTree.length) {
    throw new Error(`${assetName} bin/ differs from tag ${tag}: archive-only [${onlyArchive}], tree-only [${onlyTree}]`);
  }
  for (const name of archiveFiles) {
    const fromTree = execFileSync('git', ['--git-dir', gitDir, 'cat-file', 'blob', `${commit}:bin/${name}`], { maxBuffer: 64 * 1024 * 1024 });
    if (!fromTree.equals(zip.get(`${prefix}${name}`)())) throw new Error(`${assetName}: bin/${name} differs from tag ${tag}`);
  }

  // Changelog of every release we skip over, not just the newest one.
  const releases = await request(`https://api.github.com/repos/${FLOWSEAL_REPO}/releases?per_page=30`);
  const since = pinnedRelease ? new Date(pinnedRelease.published_at) : new Date(0);
  const body = releases
    .filter((release) => !release.draft && !release.prerelease &&
      new Date(release.published_at) > since && new Date(release.published_at) <= new Date(latest.published_at))
    .map((release) => `#### ${release.tag_name}\n\n${(release.body || '').trim()}`)
    .join('\n\n');

  const files = orderWindowsFiles(archiveFiles);
  const added = files.filter((file) => !bundle.FLOWSEAL_REQUIRED_WINDOWS_FILES.includes(file));
  const removed = bundle.FLOWSEAL_REQUIRED_WINDOWS_FILES.filter((file) => !files.includes(file));
  const changedBinaries = [];
  if (pinnedRelease) {
    // Point out engine/driver changes: those are the risky part of an update.
    git(['--git-dir', gitDir, 'fetch', '--quiet', '--depth', '1', '--no-tags',
      `https://github.com/${FLOWSEAL_REPO}.git`, bundle.FLOWSEAL_SOURCE_COMMIT]);
    const diff = git(['--git-dir', gitDir, 'diff', '--name-only', bundle.FLOWSEAL_SOURCE_COMMIT, commit, '--', 'bin']);
    for (const file of diff.split('\n').filter(Boolean)) {
      const name = file.replace(/^bin\//, '');
      if (CORE_WINDOWS_FILES.includes(name)) changedBinaries.push(name);
    }
  }

  Object.assign(result, {
    changed: true,
    commit,
    sha256: archiveSha,
    files,
    gitDir,
    url: latest.html_url,
    body,
    compare: `https://github.com/${FLOWSEAL_REPO}/compare/${encodeURIComponent(pinned)}...${encodeURIComponent(tag)}`
  });
  result.notes.push(`Archive ${assetName}: sha256 \`${archiveSha}\` (matches GitHub's published digest); bin/ matches tag \`${commit}\` byte for byte.`);
  if (added.length) result.notes.push(`New runtime files: ${added.map((file) => `\`${file}\``).join(', ')}.`);
  if (removed.length) result.notes.push(`Dropped runtime files: ${removed.map((file) => `\`${file}\``).join(', ')}.`);
  result.notes.push(changedBinaries.length
    ? `**Engine/driver binaries changed: ${changedBinaries.join(', ')}** — check winws flags in the upstream changelog.`
    : 'winws.exe, WinDivert and cygwin1.dll are unchanged.');
  return result;
}

function applyFlowseal(result) {
  const bundle = require(bundlePath);
  let text = fs.readFileSync(bundlePath, 'utf8');
  text = replaceOnce(text, /const FLOWSEAL_BUNDLE_VERSION = '[^']*';/, `const FLOWSEAL_BUNDLE_VERSION = '${result.latest}';`, 'FLOWSEAL_BUNDLE_VERSION');
  text = replaceOnce(text, /const FLOWSEAL_SOURCE_COMMIT = '[0-9a-f]{40}';/, `const FLOWSEAL_SOURCE_COMMIT = '${result.commit}';`, 'FLOWSEAL_SOURCE_COMMIT');
  text = replaceOnce(text, /const FLOWSEAL_BUNDLE_SHA256 = '[0-9a-f]{64}';/, `const FLOWSEAL_BUNDLE_SHA256 = '${result.sha256}';`, 'FLOWSEAL_BUNDLE_SHA256');
  const list = result.files.map((file) => `  '${file}'`).join(',\n');
  text = replaceOnce(text, /const FLOWSEAL_REQUIRED_WINDOWS_FILES = \[[^\]]*\];/, `const FLOWSEAL_REQUIRED_WINDOWS_FILES = [\n${list}\n];`, 'FLOWSEAL_REQUIRED_WINDOWS_FILES');
  fs.writeFileSync(bundlePath, text, 'utf8');
  delete require.cache[require.resolve(bundlePath)];

  execFileSync(process.execPath, [path.join(__dirname, 'sync-flowseal-strategies.js'), result.commit], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, FLOWSEAL_GIT_DIR: result.gitDir }
  });

  // README states which Flowseal release the strategies come from.
  const readme = fs.readFileSync(readmePath, 'utf8');
  const old = bundle.FLOWSEAL_BUNDLE_VERSION.replace(/\./g, '\\.');
  const updated = readme.split('\n')
    .map((line) => (/Flowseal/.test(line) ? line.replace(new RegExp(`(?<![\\w.])${old}(?![\\w.])`, 'g'), result.latest) : line))
    .join('\n');
  if (updated !== readme) fs.writeFileSync(readmePath, updated, 'utf8');
}

async function checkZapret() {
  const pinned = require(zapretSourcePath).ZAPRET_MACOS_COMMIT;
  const compare = await request(`https://api.github.com/repos/${ZAPRET_REPO}/compare/${pinned}...${ZAPRET_BRANCH}`);
  const head = compare.commits.length ? compare.commits[compare.commits.length - 1].sha : pinned;
  const result = { name: 'zapret tpws (macOS)', pinned, latest: head, changed: false, notes: [] };
  if (compare.status === 'identical') return result;
  if (compare.status !== 'ahead') {
    result.notes.push(`${ZAPRET_BRANCH} is "${compare.status}" relative to the pin (history rewritten?); left as is — check by hand.`);
    return result;
  }
  // The compare API lists at most 300 files; a truncated list cannot prove
  // that tpws/ is untouched, so treat it as relevant.
  const files = compare.files || [];
  const tpwsFiles = files.filter((file) => file.filename.startsWith('tpws/'));
  const truncated = files.length >= 300;
  const subjects = compare.commits.map((commit) => `\`${commit.sha.slice(0, 12)}\` ${commit.commit.message.split('\n')[0]}`);
  result.compare = compare.html_url;
  if (!tpwsFiles.length && !truncated) {
    result.notes.push(`${compare.ahead_by} new upstream commit(s), none touch tpws/ — pin kept: ${subjects.join('; ')}.`);
    return result;
  }
  const tpwsCommits = [];
  for (const commit of compare.commits) {
    const detail = await request(`https://api.github.com/repos/${ZAPRET_REPO}/commits/${commit.sha}`);
    if ((detail.files || []).some((file) => file.filename.startsWith('tpws/'))) {
      tpwsCommits.push({ sha: commit.sha, date: commit.commit.committer.date.slice(0, 10), subject: commit.commit.message.split('\n')[0] });
    }
  }
  Object.assign(result, { changed: true, tpwsFiles: tpwsFiles.map((file) => file.filename), tpwsCommits, subjects });
  result.notes.push(`tpws/ changed in: ${tpwsCommits.map((c) => `\`${c.sha.slice(0, 12)}\` ${c.subject}`).join('; ') || '(file list truncated)'}.`);
  result.notes.push(`Files: ${result.tpwsFiles.map((file) => `\`${file}\``).join(', ') || 'see compare link'}. Review for changed tpws options used by buildDarwinStrategies.`);
  return result;
}

function applyZapret(result) {
  const lines = result.tpwsCommits.length
    ? result.tpwsCommits.map((c) => `// ${c.date}: ${c.subject}\n// https://github.com/${ZAPRET_REPO}/commit/${c.sha}`)
    : [`// ${new Date().toISOString().slice(0, 10)}: upstream ${ZAPRET_BRANCH}\n// ${result.compare}`];
  const block = `// upstream-pin:start\n${lines.join('\n')}\nconst ZAPRET_MACOS_COMMIT = '${result.latest}';\n// upstream-pin:end`;
  const text = fs.readFileSync(zapretSourcePath, 'utf8');
  fs.writeFileSync(zapretSourcePath, replaceOnce(text, /\/\/ upstream-pin:start[\s\S]*?\/\/ upstream-pin:end/, block, 'upstream-pin block'), 'utf8');
}

function renderSummary(results) {
  const out = [];
  for (const result of results) {
    out.push(`### ${result.name}: ${result.changed ? `\`${short(result.pinned)}\` → \`${short(result.latest)}\`` : `up to date (\`${short(result.pinned)}\`)`}`);
    if (result.url) out.push(`Release: ${result.url}`);
    if (result.compare) out.push(`Compare: ${result.compare}`);
    for (const note of result.notes) out.push(`- ${note}`);
    if (result.body) out.push('', '<details><summary>Upstream release notes</summary>', '', result.body.trim(), '', '</details>');
    out.push('');
  }
  return out.join('\n');
}

function short(ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-upstream-'));
  try {
    const results = [await checkFlowseal(work), await checkZapret()];
    if (!options.check) {
      if (results[0].changed) applyFlowseal(results[0]);
      if (results[1].changed) applyZapret(results[1]);
    }
    const summary = renderSummary(results);
    console.log(summary);
    if (options.summary) fs.writeFileSync(options.summary, summary, 'utf8');

    const changed = results.filter((result) => result.changed);
    const title = changed.length
      ? `chore(upstream): ${changed.map((result) => result === results[0] ? `Flowseal ${result.latest}` : `zapret ${short(result.latest)}`).join(', ')}`
      : '';
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length > 0}\ntitle=${title}\n`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
