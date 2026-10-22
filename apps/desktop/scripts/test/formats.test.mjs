import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stagePackageFormat, flatpakManifest, msixManifest, executePackagePlan } from '../package-formats.mjs';

async function fixture(format = 'msix') {
  const root = await mkdtemp(join(tmpdir(), 'plur1bus package '));
  const resourcesDir = join(root, 'resources'), iconsDir = join(root, 'icons');
  await mkdir(resourcesDir); await mkdir(iconsDir);
  await mkdir(join(resourcesDir, 'cli'));
  await writeFile(join(resourcesDir, 'cli/plur1bus'), 'cli fixture');
  const binaryPath = join(root, 'built app'), helperPath = join(root, 'built helper');
  await writeFile(binaryPath, 'binary fixture'); await writeFile(helperPath, 'helper fixture');
  for (const name of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'icon.ico', '128x128.png']) await writeFile(join(iconsDir, name), 'icon fixture');
  return { root, format, target: format === 'msix' ? 'x86_64-pc-windows-msvc' : 'aarch64-unknown-linux-gnu',
    variant: 'online', storeBuild: true, version: '1.2.3', resourcesDir, iconsDir, binaryPath, helperPath,
    outDir: join(root, 'output'), publisher: 'CN=Package Test' };
}

test('MSIX stages actual inputs with required declarations and unsigned MakeAppx plan', async () => {
  const options = await fixture();
  await writeFile(join(options.iconsDir, 'Square44x44Logo.scale-200.png'), 'scaled icon fixture');
  const plan = await stagePackageFormat(options);
  const manifest = await readFile(plan.manifestPath, 'utf8');
  assert.match(manifest, /ProcessorArchitecture="x64"/);
  assert.match(manifest, /Version="1\.2\.3\.0"/);
  assert.match(manifest, /MinVersion="10\.0\.19645\.0"/);
  assert.match(manifest, /uap10:Parameters="--autostart"/);
  assert.match(manifest, /StartupTask TaskId="PLUR1BUSStartup" Enabled="true"/);
  assert.match(manifest, /File="\$\(Desktop\)\\PLUR1BUS\.lnk"/);
  assert.match(manifest, /EntryPoint="Windows.FullTrustApplication"/);
  assert.match(manifest, /Protocol Name="plur1bus"/);
  assert.match(manifest, /<uap:FileType>\.p1x<\/uap:FileType>/);
  assert.equal(await readFile(join(options.outDir, 'package/PLUR1BUS.exe'), 'utf8'), 'binary fixture');
  assert.equal(await readFile(join(options.outDir, 'package/plur1bus-host.exe'), 'utf8'), 'helper fixture');
  assert.equal(await readFile(join(options.outDir, 'package/cli/plur1bus'), 'utf8'), 'cli fixture');
  assert.deepEqual(plan.commands, [{ program: 'MakeAppx.exe', args: ['pack', '/d', join(options.outDir, 'package'), '/p', plan.artifactPath] }]);
  assert.equal(await readFile(join(options.outDir, 'package/Assets/Square44x44Logo.scale-200.png'), 'utf8'), 'scaled icon fixture');
  assert.equal(plan.unsigned, true);
  await assert.rejects(lstat(plan.artifactPath), { code: 'ENOENT' }); // No implicit execution.
  await assert.rejects(stagePackageFormat(options), { code: 'EEXIST' });
});

test('Flatpak exports protocol/file associations and Tauri resource and helper layout', async () => {
  const options = await fixture('flatpak');
  options.hicolorDir=join(options.root,'hicolor');
  await mkdir(join(options.hicolorDir,'scalable/apps'),{recursive:true});
  await writeFile(join(options.hicolorDir,'scalable/apps/app.plur1bus.desktop.svg'),'<svg/>');
  const plan = await stagePackageFormat(options);
  assert.equal(await readFile(join(options.outDir,'payload/exports/hicolor/scalable/apps/app.plur1bus.desktop.svg'),'utf8'),'<svg/>');
  const manifest = JSON.parse(await readFile(plan.manifestPath, 'utf8'));
  assert.equal(manifest.runtime, 'org.gnome.Platform');
  assert.equal(manifest.sdk, 'org.gnome.Sdk');
  assert.equal(manifest.command, 'plur1bus-desktop');
  assert.deepEqual(manifest.modules[0].sources, [{ type: 'dir', path: 'payload' }]);
  assert.ok(manifest.modules[0]['build-commands'].some(command => command.includes('/app/lib/plur1bus-desktop/')));
  assert.equal(await readFile(join(options.outDir, 'payload/resources/cli/plur1bus'), 'utf8'), 'cli fixture');
  // POSIX permission bits do not exist on NTFS (lstat reports 0o666 for every file), so the executable bit is asserted
  // where a Flatpak payload is actually staged: Linux and macOS. Windows runs the rest of this test unchanged.
  if (process.platform !== 'win32') {
    for (const name of ['plur1bus-host', 'plur1bus-desktop']) assert.equal((await lstat(join(options.outDir, 'payload/bin', name))).mode & 0o777, 0o755, name);
  }
  const desktop = await readFile(join(options.outDir, 'payload/exports/app.plur1bus.desktop.desktop'), 'utf8');
  assert.match(desktop, /Exec=plur1bus-desktop %U/);
  assert.match(desktop, /x-scheme-handler\/plur1bus;application\/x-plur1bus-extension;/);
  assert.match(await readFile(join(options.outDir, 'payload/exports/app.plur1bus.desktop.xml'), 'utf8'), /glob pattern="\*\.p1x"/);
  assert.equal(plan.commands[0].program, 'flatpak-builder');
  assert.equal(plan.commands[1].program, 'flatpak');
  assert.ok(plan.commands[1].args.includes('build-bundle'));
  assert.ok(plan.commands[0].args.includes('--arch=aarch64'));
  await assert.rejects(lstat(plan.artifactPath), { code: 'ENOENT' });
});

test('sandbox grants only named container sockets and required fixed host activation bus', () => {
  const permissions = flatpakManifest()['finish-args'];
  assert.ok(permissions.includes('--talk-name=org.freedesktop.Flatpak'));
  assert.deepEqual(permissions.filter(permission => permission.startsWith('--filesystem=')), [
    '--filesystem=xdg-run/podman:ro', '--filesystem=xdg-run/docker.sock:ro', '--filesystem=/run/docker.sock:ro',
  ]);
  assert.ok(!permissions.some(permission => /session-bus|system-bus|filesystem=host|filesystem=home|talk-name=\*/.test(permission)));
  assert.throws(() => flatpakManifest({ runtimeVersion: '49;bad' }), /invalid-flatpak-runtime/);
});

test('rejects wrong distributions, missing store provenance, and malformed package identity', async () => {
  const options = await fixture();
  await assert.rejects(stagePackageFormat({ ...options, variant: 'offline' }), /distribution-online-only/);
  await assert.rejects(stagePackageFormat({ ...options, storeBuild: false }), /store-build-required/);
  await assert.rejects(stagePackageFormat({ ...options, target: 'x86_64-unknown-linux-gnu' }), /format-target-mismatch/);
  await assert.rejects(stagePackageFormat({ ...options, version: '1.2.65536' }), /invalid-version/);
  assert.throws(() => msixManifest({ identityName: '<bad>', publisher: 'CN=Test' }), /invalid-msix-identity/);
  const escaped = msixManifest({ arch: 'arm64', version: '1.0.0.0', publisher: 'CN=A & B "test"' });
  assert.match(escaped, /Publisher="CN=A &amp; B &quot;test&quot;"/);
});

test('rejects symlink inputs and resource escapes without following them', async () => {
  const options = await fixture('flatpak');
  await symlink(options.binaryPath, join(options.resourcesDir, 'external'));
  await assert.rejects(stagePackageFormat(options), /package-resource-special-file/);
  const second = await fixture('flatpak');
  const link = join(second.root, 'app-link');
  await symlink(second.binaryPath, link);
  await assert.rejects(stagePackageFormat({ ...second, binaryPath: link }), /package-input-not-regular-file/);
});

test('native runner passes separate arguments, never a shell, and stops on failure', () => {
  const seen = [], plan = { root: '/path with spaces', commands: [{ program: 'MakeAppx.exe', args: ['pack', '/d', '/space & special'] }] };
  executePackagePlan(plan, (...args) => { seen.push(args); return { status: 0 }; });
  assert.deepEqual(seen[0], ['MakeAppx.exe', ['pack', '/d', '/space & special'], { cwd: plan.root, stdio: 'inherit', shell: false }]);
  assert.throws(() => executePackagePlan({ ...plan, commands: [...plan.commands, ...plan.commands] }, () => ({ status: 1 })), /native-packager-failed/);
  assert.throws(() => executePackagePlan(plan, () => ({ error: new Error('not-installed') })), /not-installed/);
});

test('remaining native architectures select correct package architecture', async () => {
  const windows = await fixture();
  const msix = await stagePackageFormat({ ...windows, target: 'aarch64-pc-windows-msvc' });
  assert.match(await readFile(msix.manifestPath, 'utf8'), /ProcessorArchitecture="arm64"/);
  const linux = await fixture('flatpak');
  const flatpak = await stagePackageFormat({ ...linux, target: 'x86_64-unknown-linux-gnu' });
  assert.ok(flatpak.commands[0].args.includes('--arch=x86_64'));
});
