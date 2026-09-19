'use strict';
/*
 * electron-builder afterPack hook — give the macOS app a VALID ad-hoc
 * signature.
 *
 * Why this exists: MacCleaner ships without a paid Apple Developer ID, so the
 * build runs with CSC_IDENTITY_AUTO_DISCOVERY=false. In that mode
 * electron-builder skips signing entirely, which leaves the .app bundle
 * with no _CodeSignature/CodeResources. macOS then treats the download as
 * "damaged" ("MacCleaner is damaged and can't be opened") and refuses to launch
 * it — a dead end for non-technical users, because that error has no
 * right-click-to-open escape hatch.
 *
 * Re-signing the whole bundle ad-hoc (`codesign --sign -`) produces a proper
 * _CodeSignature so the bundle verifies cleanly. A downloaded copy then shows
 * the milder, dismissable "unidentified developer" prompt instead, which the
 * README explains how to clear. (Proper notarization would remove the prompt
 * altogether, but needs the paid Developer ID.)
 *
 * When the packager DID sign with a real identity (Developer ID), that
 * signature is precious — re-signing ad-hoc would destroy it — so we detect
 * and preserve it, only stepping in when signing was skipped or stayed
 * ad-hoc.
 *
 * Nested helpers/frameworks must be signed before the outer app, so we sign
 * inside-out rather than relying on the deprecated `--deep` flag.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function sign(target) {
  // Plain ad-hoc, no hardened runtime: MacCleaner is not notarized, and the
  // hardened runtime would block V8's JIT without extra entitlements.
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: 'inherit',
  });
}

/** True when `appPath` already carries a REAL (identity-backed) signature.
 *  The CodeResources seal proves a signature exists at all; `codesign -dv`
 *  (whose report goes to stderr even on success) separates real from ad-hoc:
 *  ad-hoc shows `Signature=adhoc` and no TeamIdentifier, a real signature
 *  carries `TeamIdentifier=<id>`. Unsigned/unreadable → false (sign as today). */
function hasRealSignature(appPath) {
  const seal = path.join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
  if (!fs.existsSync(seal)) return false; // signing was skipped entirely
  const probe = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  const report = `${probe.stdout || ''}${probe.stderr || ''}`;
  return !/Signature=adhoc/.test(report) && /TeamIdentifier=\S+/.test(report);
}

function signInsideOut(appPath) {
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, entry);
      // Helper apps carry their own executable; sign that first.
      if (entry.endsWith('.app')) {
        const inner = path.join(full, 'Contents', 'MacOS');
        if (fs.existsSync(inner)) {
          for (const bin of fs.readdirSync(inner)) sign(path.join(inner, bin));
        }
      }
      sign(full); // framework bundle or loose .dylib
    }
  }
  sign(appPath); // outer bundle last, so its seal covers everything within
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename; // "MacCleaner"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  // A real (Developer ID) signature survives packaging — never clobber it
  // with ad-hoc. Only unsigned or ad-hoc bundles get the treatment below.
  if (hasRealSignature(appPath)) {
    console.log('[afterPack] real (identity) signature present — skipping ad-hoc re-sign');
    return;
  }
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  try {
    signInsideOut(appPath);
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc signature verified');
  } catch (err) {
    console.error('[afterPack] ad-hoc signing failed:', err.message);
    throw err; // a broken signature is worse than a loud build failure
  }
};
