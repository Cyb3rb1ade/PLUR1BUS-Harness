// Native format staging. This never signs, installs, or invokes native tools unless requested.
import { copyFile, mkdir, readdir, lstat, writeFile, chmod, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const APP_ID = 'app.plur1bus.desktop';
const targets = new Map([
  ['x86_64-pc-windows-msvc', ['msix', 'x64']],
  ['aarch64-pc-windows-msvc', ['msix', 'arm64']],
  ['x86_64-unknown-linux-gnu', ['flatpak', 'x86_64']],
  ['aarch64-unknown-linux-gnu', ['flatpak', 'aarch64']],
]);
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const fail = message => { throw new Error(message); };
const WINDOWS_ASSETS = ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'icon.ico'];

function selection(options) {
  const target = targets.get(options.target);
  if (!target || target[0] !== options.format) fail('format-target-mismatch');
  if (options.variant !== 'online') fail('distribution-online-only');
  // Both distributors own updates; this is a build provenance assertion from the wrapper.
  if (options.storeBuild !== true) fail('store-build-required: compile --no-default-features --features store');
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(options.version ?? '')) fail('invalid-version');
  const components = options.version.split('.').map(Number);
  if (components.some(number => number > 65535)) fail('invalid-version');
  while (components.length < 4) components.push(0);
  if (!options.binaryPath || !options.helperPath || !options.resourcesDir || !options.iconsDir || !options.outDir) fail('missing-package-input');
  return { arch: target[1], version: components.join('.') };
}

async function regularFile(source, destination, executable = false) {
  if (!(await lstat(source)).isFile()) fail('package-input-not-regular-file');
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, 1); // COPYFILE_EXCL; never clobber existing staged content.
  if (executable) await chmod(destination, 0o755);
}
async function copyTree(source, destination) {
  if (!(await lstat(source)).isDirectory()) fail('package-resource-not-directory');
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await regularFile(from, to);
    else fail('package-resource-special-file');
  }
}

export function msixManifest({ arch, version, publisher = 'CN=PLUR1BUS Development', identityName = APP_ID }) {
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName)) fail('invalid-msix-identity');
  if (!publisher.startsWith('CN=') || /[\x00-\x1f]/.test(publisher)) fail('invalid-msix-publisher');
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10" xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10" xmlns:desktop7="http://schemas.microsoft.com/appx/manifest/desktop/windows10/7" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap uap10 desktop desktop7 rescap">
  <Identity Name="${xml(identityName)}" Publisher="${xml(publisher)}" Version="${xml(version)}" ProcessorArchitecture="${xml(arch)}"/>
  <Properties><DisplayName>PLUR1BUS</DisplayName><PublisherDisplayName>PLUR1BUS</PublisherDisplayName><Logo>Assets\\StoreLogo.png</Logo></Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19645.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
  <Resources><Resource Language="en-US"/><Resource Language="de-DE"/></Resources>
  <Applications><Application Id="PLUR1BUS" Executable="PLUR1BUS.exe" EntryPoint="Windows.FullTrustApplication">
    <uap:VisualElements DisplayName="PLUR1BUS" Description="PLUR1BUS desktop shell" BackgroundColor="transparent" Square44x44Logo="Assets\\Square44x44Logo.png" Square150x150Logo="Assets\\Square150x150Logo.png"/>
    <Extensions>
      <desktop:Extension Category="windows.startupTask" Executable="PLUR1BUS.exe" EntryPoint="Windows.FullTrustApplication" uap10:Parameters="--autostart"><desktop:StartupTask TaskId="PLUR1BUSStartup" Enabled="true" DisplayName="PLUR1BUS"/></desktop:Extension>
      <desktop7:Extension Category="windows.shortcut" Executable="PLUR1BUS.exe" EntryPoint="Windows.FullTrustApplication"><desktop7:Shortcut File="$(Desktop)\\PLUR1BUS.lnk" Icon="Assets\\icon.ico" Description="PLUR1BUS"/></desktop7:Extension>
      <uap:Extension Category="windows.protocol"><uap:Protocol Name="plur1bus"><uap:DisplayName>PLUR1BUS</uap:DisplayName></uap:Protocol></uap:Extension>
      <uap:Extension Category="windows.fileTypeAssociation"><uap:FileTypeAssociation Name="plur1bus-extension"><uap:DisplayName>PLUR1BUS extension</uap:DisplayName><uap:SupportedFileTypes><uap:FileType>.p1x</uap:FileType></uap:SupportedFileTypes></uap:FileTypeAssociation></uap:Extension>
    </Extensions>
  </Application></Applications>
  <Capabilities><Capability Name="internetClient"/><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
`;
}

export function flatpakManifest({ runtimeVersion = '49' } = {}) {
  if (!/^\d{2}$/.test(runtimeVersion)) fail('invalid-flatpak-runtime');
  return {
    'app-id': APP_ID, runtime: 'org.gnome.Platform', 'runtime-version': runtimeVersion,
    sdk: 'org.gnome.Sdk', command: 'plur1bus-desktop',
    'finish-args': [
      '--share=network', '--share=ipc', '--socket=wayland', '--socket=fallback-x11', '--device=dri',
      // Fixed runtime sockets only. Host commands are limited in Rust to systemctl socket activation.
      '--filesystem=xdg-run/podman:ro', '--filesystem=xdg-run/docker.sock:ro',
      '--filesystem=/run/docker.sock:ro', '--talk-name=org.freedesktop.Flatpak',
    ],
    // Flatpak uses the background portal: Rust skips native appindicator tray creation here.
    // Do not bundle unpinned host libraries into a GNOME ABI.
    modules: [{ name: 'plur1bus-desktop', buildsystem: 'simple',
      'build-commands': ['mkdir -p /app/bin /app/lib/plur1bus-desktop /app/share/applications /app/share/metainfo /app/share/icons/hicolor/128x128/apps /app/share/mime/packages',
        'install -m755 bin/* /app/bin/', 'cp -R resources/. /app/lib/plur1bus-desktop/',
        `install -m644 exports/${APP_ID}.desktop /app/share/applications/`,
        `install -m644 exports/${APP_ID}.metainfo.xml /app/share/metainfo/`,
        `install -m644 exports/${APP_ID}.png /app/share/icons/hicolor/128x128/apps/`,
        'if test -d exports/hicolor; then cp -R exports/hicolor/. /app/share/icons/hicolor/; fi',
        `install -m644 exports/${APP_ID}.xml /app/share/mime/packages/`],
      sources: [{ type: 'dir', path: 'payload' }],
    }],
  };
}

export async function stagePackageFormat(options) {
  const selected = selection(options), root = resolve(options.outDir);
  await mkdir(root); // exclusive leaf: do not reuse an existing staging tree.
  let manifestPath, artifactPath, commands;
  if (options.format === 'msix') {
    const stage = join(root, 'package');
    await mkdir(stage);
    await regularFile(options.binaryPath, join(stage, 'PLUR1BUS.exe'));
    await regularFile(options.helperPath, join(stage, 'plur1bus-host.exe'));
    await copyTree(options.resourcesDir, stage);
    for (const name of WINDOWS_ASSETS) if (!(await lstat(join(options.iconsDir, name))).isFile()) fail('msix-asset-not-regular-file');
    await copyTree(options.iconsDir, join(stage, 'Assets'));
    manifestPath = join(stage, 'AppxManifest.xml');
    await writeFile(manifestPath, msixManifest({ ...selected, publisher: options.publisher, identityName: options.identityName }), { flag: 'wx' });
    artifactPath = join(root, `PLUR1BUS-${selected.version}-${selected.arch}.msix`);
    commands = [{ program: 'MakeAppx.exe', args: ['pack', '/d', stage, '/p', artifactPath] }];
  } else {
    const payload = join(root, 'payload');
    await mkdir(payload);
    await regularFile(options.binaryPath, join(payload, 'bin/plur1bus-desktop'), true);
    await regularFile(options.helperPath, join(payload, 'bin/plur1bus-host'), true);
    await copyTree(options.resourcesDir, join(payload, 'resources'));
    const exports = join(payload, 'exports');
    await mkdir(exports);
    if(options.hicolorDir)await copyTree(options.hicolorDir,join(exports,'hicolor'));
    await regularFile(join(options.iconsDir, '128x128.png'), join(exports, `${APP_ID}.png`));
    await writeFile(join(exports, `${APP_ID}.desktop`), `[Desktop Entry]\nType=Application\nName=PLUR1BUS\nComment=PLUR1BUS desktop shell\nExec=plur1bus-desktop %U\nIcon=${APP_ID}\nTerminal=false\nCategories=Utility;\nMimeType=x-scheme-handler/plur1bus;application/x-plur1bus-extension;\nStartupNotify=true\n`);
    await writeFile(join(exports, `${APP_ID}.xml`), `<?xml version="1.0" encoding="UTF-8"?>\n<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info"><mime-type type="application/x-plur1bus-extension"><comment>PLUR1BUS extension</comment><glob pattern="*.p1x"/></mime-type></mime-info>\n`);
    await writeFile(join(exports, `${APP_ID}.metainfo.xml`), `<?xml version="1.0" encoding="UTF-8"?>\n<component type="desktop-application"><id>${APP_ID}</id><metadata_license>CC0-1.0</metadata_license><project_license>MIT</project_license><name>PLUR1BUS</name><summary>Manage your PLUR1BUS instance</summary><description><p>Connect to and manage a PLUR1BUS instance with a native desktop shell.</p></description><launchable type="desktop-id">${APP_ID}.desktop</launchable><url type="homepage">https://github.com/Cyb3rb1ade/PLUR1BUS-Harness</url><provides><binary>plur1bus-desktop</binary></provides></component>\n`);
    manifestPath = join(root, `${APP_ID}.json`);
    await writeFile(manifestPath, JSON.stringify(flatpakManifest(options), null, 2) + '\n');
    artifactPath = join(root, `PLUR1BUS-${selected.version}-${selected.arch}.flatpak`);
    commands = [
      { program: 'flatpak-builder', args: [`--arch=${selected.arch}`, `--repo=${join(root, 'repo')}`, join(root, 'build'), manifestPath] },
      { program: 'flatpak', args: ['build-bundle', `--arch=${selected.arch}`, join(root, 'repo'), artifactPath, APP_ID, 'master'] },
    ];
  }
  const plan = { root, manifestPath, artifactPath, commands, unsigned: true, storeBuild: true };
  await writeFile(join(root, 'package-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  if (options.execute === true) {
    if (options.format === 'msix' && !options.publisher) fail('native-msix-requires-explicit-publisher');
    executePackagePlan(plan);
  }
  return plan;
}

export function executePackagePlan(plan, runner = spawnSync) {
  for (const command of plan.commands) {
    const result = runner(command.program, command.args, { cwd: plan.root, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`native-packager-failed: ${command.program}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // JSON options preserve paths containing spaces without a shell parser. Native tools are opt-in.
  const [input, execute] = process.argv.slice(2);
  if (!input || (execute !== undefined && execute !== '--execute')) fail('Usage: package-formats.mjs options.json [--execute]');
  const options = JSON.parse(await readFile(input, 'utf8'));
  const plan = await stagePackageFormat({ ...options, execute: execute === '--execute' });
  console.log(JSON.stringify(plan));
}
