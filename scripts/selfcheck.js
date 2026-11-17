#!/usr/bin/env node
/* Assert-based self-check for the pure logic (no test framework in this repo).
   Run after `npm run build`:  npm run check  */
const assert = require('assert');
const os = require('os');
const path = require('path');
const { sanitizePath } = require('../dist/utils/pathSanitizer');
const { pickCask, caskAppName, brewErrorLine } = require('../dist/services/updater');
const { groupProcesses } = require('../dist/services/maintenance');
const { cacheExcluded } = require('../dist/services/macClean');
const { collectCleanupSuggestions } = require('../dist/services/cleanupRules');

// Paths: trailing whitespace / CR are part of real file names — never trimmed.
assert.strictEqual(sanitizePath('/tmp/x/Icon\r'), '/tmp/x/Icon\r');
assert.strictEqual(sanitizePath('/tmp/x/report '), '/tmp/x/report ');
assert.strictEqual(sanitizePath('~/a/../b'), path.join(os.homedir(), 'b'));
assert.throws(() => sanitizePath('   '));

// Cask choice: never guess between look-alikes; prefer what brew installed.
const c = (token, latest = false) => ({ token, version: '1', rawVersion: latest ? 'latest' : '1', latest, bundleIds: [] });
const chromium = [c('chromium', true), c('ungoogled-chromium')];
assert.strictEqual(pickCask(chromium, new Set(['chromium'])), null, ':latest owner → no offer');
assert.strictEqual(pickCask(chromium, new Set()), null, 'ambiguous → no offer');
assert.strictEqual(pickCask(chromium, new Set(['ungoogled-chromium'])).token, 'ungoogled-chromium');
assert.strictEqual(pickCask([c('slack')], new Set()).token, 'slack');
assert.strictEqual(pickCask(undefined, new Set()), null);
assert.strictEqual(caskAppName(['Android Studio.app', { target: 'Android Studio Preview Beta.app' }]), 'Android Studio Preview Beta');
assert.strictEqual(caskAppName('chrome-mac/Chromium.app'), 'Chromium');
assert.strictEqual(caskAppName('tool.pkg'), null);
assert.strictEqual(brewErrorLine('==> Downloading\nError: It seems the App source is not there.\n==> Purging'), 'It seems the App source is not there.');

// Process grouping: helpers fold into their app.
const top = groupProcesses('  1000  1.5 /Applications/Foo.app/Contents/MacOS/Foo\n  3000  2.0 /Applications/Foo.app/Contents/Frameworks/Foo Helper.app/Contents/MacOS/Foo Helper\n  500  0.1 /usr/sbin/bar\n');
assert.deepStrictEqual(top[0], { name: 'Foo', memBytes: 4000 * 1024, cpuPercent: 4 });
assert.strictEqual(top.length, 1, 'daemons are not listed');

// Smart Scan safelist.
assert.ok(cacheExcluded('com.apple.amsaccountsd'));
assert.ok(cacheExcluded('ms-playwright'));
assert.ok(cacheExcluded('com.spotify.client'));
assert.ok(!cacheExcluded('com.apple.dt.Xcode'));
assert.ok(!cacheExcluded('Homebrew'));

// Cleanup suggestions: ~/.gradle is never offered; only direct Downloads children.
const home = os.homedir();
const old = Date.now() - 400 * 86_400_000;
const file = (p, size) => ({ name: path.basename(p), path: p, size, type: 'file', modifiedAt: old });
const dir = (p, children) => ({ name: path.basename(p), path: p, size: children.reduce((s, n) => s + n.size, 0), type: 'dir', modifiedAt: old, children });
const dl = path.join(home, 'Downloads');
const tree = dir(home, [
  dir(path.join(home, '.gradle'), [file(path.join(home, '.gradle', 'gradle.properties'), 10)]),
  dir(dl, [
    file(path.join(dl, 'big.iso'), 5e9),
    dir(path.join(dl, 'repo'), [file(path.join(dl, 'repo', 'pack.bin'), 5e9)]),
  ]),
]);
const groups = collectCleanupSuggestions(tree, []);
const paths = groups.flatMap((g) => g.items.map((i) => i.path));
assert.ok(!paths.includes(path.join(home, '.gradle')), '~/.gradle must not be offered');
assert.ok(paths.includes(path.join(dl, 'big.iso')));
assert.ok(!paths.includes(path.join(dl, 'repo', 'pack.bin')), 'nested Downloads files are not standalone targets');

console.log('selfcheck: all assertions passed');

// Running-app guard by process name (apps lsappinfo doesn't list).
const { matchesRunningAppName } = require('../dist/services/macClean');
const runs = [['asta'], ['brave', 'browser']];
assert.ok(matchesRunningAppName('com.veroxstudio.asta', runs));
assert.ok(matchesRunningAppName('Asta Shared Profiles', runs));
assert.ok(matchesRunningAppName('com.brave.Browser', runs));
assert.ok(!matchesRunningAppName('Homebrew', runs));
assert.ok(!matchesRunningAppName('pasta', runs));
console.log('selfcheck: running-app guard ok');

const { versionIsPrefix } = require('../dist/services/updater');
assert.ok(versionIsPrefix('2026.2', '2026.2.3.4'));
assert.ok(versionIsPrefix('134.0', '134.0.1'));
assert.ok(!versionIsPrefix('133.0', '134.0.1'));
assert.ok(!versionIsPrefix('', '1.0'));
console.log('selfcheck: version prefix ok');

// Treemap layout: every rectangle keeps its area and stays inside the box.
const { squarify } = require('../dist/utils/treemap');
const areas = [600, 300, 200, 150, 100, 50];
const rects = squarify(areas, { x: 0, y: 0, w: 40, h: 35 });
rects.forEach((r, i) => {
  assert.ok(Math.abs(r.w * r.h - areas[i]) < 1e-6, 'area preserved');
  assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 40 + 1e-6 && r.y + r.h <= 35 + 1e-6, 'inside the box');
});
console.log('selfcheck: treemap ok');
