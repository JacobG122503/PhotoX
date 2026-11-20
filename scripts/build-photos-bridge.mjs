// Builds helper/PhotosBridge.swift into "helper/build/PhotoX Photos.app", a background app that lets
// PhotoX read the Apple Photos library through PhotoKit. macOS only, and it needs the Xcode command
// line tools (swiftc). It only rebuilds when the Swift source changes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'helper/PhotosBridge.swift');
const app = join(root, 'helper/build/PhotoX Photos.app');
const bin = join(app, 'Contents/MacOS/PhotoXPhotos');
const stamp = join(root, 'helper/build/.source-hash');
const id = 'local.photox.photos-bridge';

if (process.platform !== 'darwin') {
  console.error('PhotoX: the Apple Photos helper only runs on macOS.');
  process.exit(1);
}

const hash = createHash('sha256').update(readFileSync(src)).digest('hex');
if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) process.exit(0);

let swiftc;
try {
  swiftc = execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim();
} catch {
  console.error('PhotoX: swiftc not found. Run `xcode-select --install`, then `npm run dev` again.');
  process.exit(1);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${id}</string>
  <key>CFBundleName</key><string>PhotoX Photos</string>
  <key>CFBundleDisplayName</key><string>PhotoX Photos</string>
  <key>CFBundleExecutable</key><string>PhotoXPhotos</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPhotoLibraryUsageDescription</key><string>PhotoX reads your photos and their locations on this Mac to show them on a map. Nothing is uploaded.</string>
</dict></plist>
`;

console.log('PhotoX: building the Apple Photos helper…');
rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
writeFileSync(join(app, 'Contents/Info.plist'), plist);
// Some Command Line Tools installs keep a stale include/swift/module.modulemap next to the newer
// bridging.modulemap. Both define SwiftBridging, so every framework import fails. Hide the stale
// file from this compile with a VFS overlay instead of touching system files.
const args = ['-O', '-swift-version', '5', '-o', bin, src];
const incSwift = join(swiftc, '../../include/swift');
if (existsSync(join(incSwift, 'module.modulemap')) && existsSync(join(incSwift, 'bridging.modulemap'))) {
  const empty = join(root, 'helper/build/empty.modulemap');
  const overlay = join(root, 'helper/build/clt-overlay.yaml');
  writeFileSync(empty, '');
  writeFileSync(overlay, JSON.stringify({
    version: 0, 'case-sensitive': 'false',
    roots: [{ type: 'directory', name: incSwift, contents: [{ type: 'file', name: 'module.modulemap', 'external-contents': empty }] }],
  }));
  args.unshift('-vfsoverlay', overlay, '-Xcc', '-ivfsoverlay', '-Xcc', overlay);
}
try {
  execFileSync('xcrun', ['swiftc', ...args], { stdio: 'inherit' });
  // Ad-hoc signature (required on Apple Silicon). Naming the bundle identifier as the designated
  // requirement keeps the Photos permission across rebuilds instead of asking again each time.
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', id, `-r=designated => identifier "${id}"`, app], { stdio: 'inherit' });
} catch {
  rmSync(app, { recursive: true, force: true });
  console.error('PhotoX: the Apple Photos helper failed to build (see above).');
  process.exit(1);
}
writeFileSync(stamp, hash);
console.log(`PhotoX: Photos helper ready (${Math.round(statSync(bin).size / 1024)} KB).`);
