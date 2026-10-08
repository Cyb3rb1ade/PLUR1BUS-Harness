import { readFileSync, writeFileSync } from 'node:fs';
// Syft serial numbers/timestamps describe the scan invocation; omit them, preserving dependency identifiers.
for (const file of process.argv.slice(2)) {
  const bom = JSON.parse(readFileSync(file, 'utf8'));
  if (bom.bomFormat !== 'CycloneDX' || !bom.components?.length) throw new Error(`empty or invalid SBOM: ${file}`);
  delete bom.serialNumber;
  delete bom.metadata?.timestamp;
  // The root ID is derived from the temporary scanner path. Replace all references together.
  const oldRoot = bom.metadata?.component?.["bom-ref"];
  const newRoot = `urn:plur1bus:sbom:${bom.metadata?.component?.name}`;
  if (oldRoot) {
    const replaceRef = value => {
      if (value === oldRoot) return newRoot;
      if (Array.isArray(value)) return value.map(replaceRef);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceRef(v)]));
      return value;
    };
    Object.assign(bom, replaceRef(bom));
  }
  for (const component of bom.components) {
    if (component.type === 'file') component.name = component.name.replaceAll('\\', '/').split('/').at(-1);
  }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable).sort((a, b) => {
      const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0;
    });
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    return value;
  }
  writeFileSync(file, `${JSON.stringify(stable(bom), null, 2)}\n`);
}
