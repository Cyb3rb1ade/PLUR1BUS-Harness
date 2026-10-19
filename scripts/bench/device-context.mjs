// Owner-designated roles only. Hardware numbers always come from the running device.
export const deviceRoles = Object.freeze({
  'owner-mac': { label: 'Owner-Mac (Apple Silicon)', os: 'darwin', architecture: 'arm64', virtualMachine: false, hostRole: null, availability: 'owner device' },
  'nas-windows-x64': { label: 'Windows 11 x64 VM on NAS', os: 'win32', architecture: 'x64', virtualMachine: true, hostRole: 'NAS', availability: 'always running' },
  'parallels-windows-arm64': { label: 'Windows 11 arm64 Parallels VM', os: 'win32', architecture: 'arm64', virtualMachine: true, hostRole: 'Owner-Mac', availability: 'external drive must be connected' },
  'nas-ubuntu-x64': { label: 'Ubuntu x64 VM on NAS', os: 'linux', architecture: 'x64', virtualMachine: true, hostRole: 'NAS', availability: 'owner VM' },
});
export function deviceContext(role, detected) {
  if (!role) return { role: null, virtualMachine: null, hostRole: null, resourcesScope: 'unknown', bareMetalComparisonEligible: false, comparisonNote: 'Device role not specified; virtualization unknown. Do not infer bare-metal acceptance.' };
  const d = deviceRoles[role];
  if (!d || d.os !== detected.os || d.architecture !== detected.architecture) throw new Error('Device role does not match the detected OS/architecture');
  return { role, ...d, resourcesScope: d.virtualMachine ? 'guest (reported logical cores are vCPUs; RAM is guest-visible)' : 'physical device', bareMetalComparisonEligible: !d.virtualMachine,
    comparisonNote: d.virtualMachine ? 'VM measurement: targets are diagnostic only; do not equate this result with bare-metal budget acceptance. Host hardware is not inferred from guest data.' : 'Physical-device measurement; acceptance still depends on complete benchmark coverage and owner review.' };
}
