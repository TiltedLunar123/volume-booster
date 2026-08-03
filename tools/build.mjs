/*
 * Assembles the two store packages from one source tree.
 *
 * There is no bundler here and there never will be: the extension ships the
 * same plain JS that is in the repo. This script only picks the right manifest,
 * copies files, and zips.
 *
 *   node tools/build.mjs          build dist/chrome, dist/firefox and both zips
 *   node tools/build.mjs --check  validate only, used by CI
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeZip } from './zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const SHARED = [
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png'
];

const SCRIPTS = ['background.js', 'content.js', 'popup.js'];
const TARGETS = [
  { name: 'chrome', manifest: 'manifest.chrome.json' },
  { name: 'firefox', manifest: 'manifest.firefox.json' }
];

const checkOnly = process.argv.includes('--check');
let failures = 0;

function fail(message) {
  console.error(`  FAIL  ${message}`);
  failures++;
}

function ok(message) {
  console.log(`  ok    ${message}`);
}

/* ------------------------------ validate ----------------------------- */

console.log('checking sources');

for (const file of SCRIPTS) {
  const full = path.join(SRC, file);
  const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${file} does not parse\n${result.stderr}`);
  else ok(`${file} parses`);
}

for (const file of [...SHARED, 'manifest.chrome.json', 'manifest.firefox.json']) {
  if (!fs.existsSync(path.join(SRC, file))) {
    fail(`missing src/${file}${file.startsWith('icons/') ? ' (run node tools/make-icons.mjs)' : ''}`);
  }
}

const REQUIRED_KEYS = ['manifest_version', 'name', 'version', 'action', 'permissions', 'content_scripts'];
const manifests = {};

for (const target of TARGETS) {
  const full = path.join(SRC, target.manifest);
  if (!fs.existsSync(full)) continue;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    fail(`${target.manifest} is not valid JSON: ${error.message}`);
    continue;
  }
  manifests[target.name] = parsed;

  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) fail(`${target.manifest} is missing "${key}"`);
  }
  if (parsed.manifest_version !== 3) fail(`${target.manifest} is not manifest v3`);
  if (parsed.host_permissions) {
    fail(`${target.manifest} declares host_permissions, which this extension does not need`);
  }
  if ((parsed.permissions || []).includes('tabs')) {
    fail(`${target.manifest} requests the "tabs" permission, which this extension does not need`);
  }

  const referenced = new Set([
    ...(parsed.content_scripts || []).flatMap((entry) => entry.js || []),
    ...Object.values(parsed.icons || {}),
    ...Object.values((parsed.action || {}).default_icon || {}),
    (parsed.action || {}).default_popup,
    (parsed.background || {}).service_worker,
    ...((parsed.background || {}).scripts || [])
  ].filter(Boolean));

  for (const file of referenced) {
    if (!fs.existsSync(path.join(SRC, file))) {
      fail(`${target.manifest} references ${file}, which does not exist`);
    }
  }
  ok(`${target.manifest} is valid`);
}

if (manifests.chrome && manifests.firefox) {
  if (manifests.chrome.version !== manifests.firefox.version) {
    fail('the two manifests disagree about "version"');
  } else {
    ok(`version ${manifests.chrome.version} matches across both manifests`);
  }
  if (!manifests.chrome.background?.service_worker) {
    fail('the Chrome manifest needs background.service_worker');
  }
  if (!manifests.firefox.background?.scripts) {
    fail('the Firefox manifest needs background.scripts');
  }
  if (!manifests.firefox.browser_specific_settings?.gecko?.id) {
    fail('the Firefox manifest needs browser_specific_settings.gecko.id');
  }

  // Firefox only started granting an MV3 extension's content-script origins
  // at install time in 127. On anything older nothing prompts, the declared
  // content script never injects, and the extension looks dead on every page
  // until the user finds the popup. Refuse to ship a floor below that.
  const minVersion = parseFloat(manifests.firefox.browser_specific_settings?.gecko?.strict_min_version);
  if (!(minVersion >= 127)) {
    fail('strict_min_version must be at least 127.0: earlier Firefox never grants MV3 content-script origins, so the extension silently does nothing');
  } else {
    ok(`Firefox floor ${minVersion} grants content-script origins at install`);
  }

  // AMO rejects the upload outright without this, and the value has to keep
  // matching the no-data-collection claim made in the listing and PRIVACY.md.
  const collection = manifests.firefox.browser_specific_settings?.gecko?.data_collection_permissions;
  if (!collection) {
    fail('the Firefox manifest needs browser_specific_settings.gecko.data_collection_permissions, or AMO refuses the upload');
  } else if (JSON.stringify(collection.required) !== JSON.stringify(['none'])) {
    fail('data_collection_permissions.required must be exactly ["none"] while the listing claims no data is collected');
  } else {
    ok('Firefox data collection is declared as none');
  }
}

// No network calls anywhere in the shipped code. This is a promise made in the
// store listing, so it is enforced rather than trusted.
const BANNED = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bimportScripts\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /WebSocket/];
for (const file of SCRIPTS) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  for (const pattern of BANNED) {
    if (pattern.test(source)) fail(`${file} contains ${pattern}, which the privacy claim forbids`);
  }
}
ok('no network or dynamic-code APIs in the shipped scripts');

if (failures > 0) {
  console.error(`\n${failures} problem${failures === 1 ? '' : 's'} found`);
  process.exit(1);
}

if (checkOnly) {
  console.log('\nall checks passed');
  process.exit(0);
}

/* -------------------------------- build ------------------------------ */

console.log('\nbuilding');
fs.rmSync(DIST, { recursive: true, force: true });

for (const target of TARGETS) {
  const outDir = path.join(DIST, target.name);
  const entries = [];

  for (const file of SHARED) {
    const data = fs.readFileSync(path.join(SRC, file));
    const dest = path.join(outDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    entries.push({ name: file, data });
  }

  const manifest = fs.readFileSync(path.join(SRC, target.manifest));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifest);
  entries.push({ name: 'manifest.json', data: manifest });

  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  const version = manifests[target.name].version;
  const zipPath = path.join(DIST, `volume-booster-${target.name}-v${version}.zip`);
  const zip = makeZip(entries);
  fs.writeFileSync(zipPath, zip);

  ok(`dist/${target.name}/ (${entries.length} files)`);
  ok(`${path.basename(zipPath)} (${(zip.length / 1024).toFixed(1)} KB)`);
}

console.log('\nload unpacked from dist/chrome or dist/firefox, or upload the zips');
