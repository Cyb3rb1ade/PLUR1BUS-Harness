// Read-only PE metadata for the native diagnostic, never a production loader.
const MACHINES = new Map([[0x14c, 'x86'], [0x8664, 'x64'], [0xaa64, 'arm64'], [0xa641, 'arm64ec'], [0xa64e, 'arm64x']]);
export const isApiSet = name => /^(?:api|ext)-ms-/i.test(name);

export function parsePe(bytes) {
  let metadataBytes = 0, importedSymbols = 0;
  const fail = reason => { throw new Error(`Invalid PE: ${reason}`); };
  const check = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > bytes.length) fail('truncated range');
    return offset;
  };
  const u16 = offset => bytes.readUInt16LE(check(offset, 2));
  const u32 = offset => bytes.readUInt32LE(check(offset, 4));
  const u64 = offset => bytes.readBigUInt64LE(check(offset, 8));
  if (u16(0) !== 0x5a4d) fail('DOS signature');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) fail('PE signature');
  const machine = u16(pe + 4), sectionCount = u16(pe + 6);
  const optional = pe + 24, optionalSize = u16(pe + 20);
  check(optional, optionalSize);
  const magic = u16(optional), wide = magic === 0x20b;
  if (magic !== 0x10b && !wide) fail('optional-header magic');
  const dirsStart = wide ? 112 : 96;
  if (optionalSize < dirsStart || sectionCount > 96) fail('header bounds');
  const imageBase = wide ? u64(optional + 24) : BigInt(u32(optional + 28));
  const headerSize = u32(optional + 60);
  if (headerSize > bytes.length || headerSize < optional + optionalSize) fail('header size');
  const dirCount = u32(optional + dirsStart - 4);
  if (dirCount > 16 || dirsStart + dirCount * 8 > optionalSize) fail('directory bounds');
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const pos = optional + optionalSize + i * 40;
    check(pos, 40);
    sections.push({ virtualSize: u32(pos + 8), rva: u32(pos + 12), rawSize: u32(pos + 16), offset: u32(pos + 20) });
  }
  const offsetOf = (rva, size = 1) => {
    if (!Number.isSafeInteger(rva) || rva < 0) fail('RVA');
    if (rva < headerSize && rva + size <= headerSize) return check(rva, size);
    for (const section of sections) {
      const delta = rva - section.rva;
      if (delta >= 0 && delta + size <= section.rawSize) return check(section.offset + delta, size);
    }
    fail('unbacked RVA');
  };
  const stringAt = rva => {
    const result = [];
    for (let i = 0; i < 4096; i++) {
      if (++metadataBytes > 8 * 1024 * 1024) fail('metadata budget');
      const byte = bytes[offsetOf(rva + i)];
      if (byte === 0) return Buffer.from(result).toString('ascii');
      if (byte < 0x20 || byte > 0x7e) fail('non-ASCII import metadata');
      result.push(byte);
    }
    fail('unterminated import metadata');
  };
  const directory = index => index < dirCount
    ? { rva: u32(optional + dirsStart + index * 8), size: u32(optional + dirsStart + index * 8 + 4) }
    : { rva: 0, size: 0 };
  const asRva = (value, va = false) => {
    const address = BigInt(value) - (va ? imageBase : 0n);
    if (address < 0n || address > 0xffffffffn) fail('address outside RVA range');
    return Number(address);
  };
  const imports = [];
  const importDirectory = (index, delayed) => {
    const { rva, size } = directory(index);
    if (rva === 0 && size === 0) return;
    if (!rva || size < (delayed ? 32 : 20)) fail('import directory size');
    const stride = delayed ? 32 : 20;
    for (let i = 0; i < Math.min(Math.floor(size / stride), 4096); i++) {
      const pos = offsetOf(rva + i * stride, stride);
      if (bytes.subarray(pos, pos + stride).every(byte => byte === 0)) return;
      const attrs = delayed ? u32(pos) : 1;
      if (delayed && attrs > 1) fail('delay-import attributes');
      const va = delayed && attrs === 0;
      const name = stringAt(asRva(u32(pos + (delayed ? 4 : 12)), va));
      // Import lookup never accepts paths or shell input from PE metadata.
      if (!/^[a-z0-9_.-]+\.dll$/i.test(name) || name.includes('..')) fail('import module name');
      const thunk = asRva(delayed ? (u32(pos + 16) || u32(pos + 12)) : (u32(pos) || u32(pos + 16)), va);
      const symbols = [], ordinalFlag = wide ? 1n << 63n : 1n << 31n;
      let terminated = false;
      for (let j = 0; j < 65536; j++) {
        const address = offsetOf(thunk + j * (wide ? 8 : 4), wide ? 8 : 4);
        const value = wide ? u64(address) : BigInt(u32(address));
        if (value === 0n) { terminated = true; break; }
        if (++importedSymbols > 65536) fail('import symbol budget');
        if (value & ordinalFlag) {
          if (value & ~(ordinalFlag | 0xffffn)) fail('invalid ordinal thunk');
          symbols.push({ ordinal: Number(value & 0xffffn) });
        } else symbols.push({ name: stringAt(asRva(value, va) + 2) });
      }
      if (!terminated) fail('unterminated thunk table');
      imports.push({ dll: name, apiSet: isApiSet(name), delayed, symbols });
    }
    fail('unterminated descriptor table');
  };
  importDirectory(1, false);
  importDirectory(13, true);

  // Forwarders explain whether a missing GetProcAddress result was itself
  // forwarded to another DLL/procedure. No machine-code addresses are emitted.
  const exports = [], exportDir = directory(0);
  if (exportDir.rva) {
    if (exportDir.size < 40) fail('export directory size');
    const pos = offsetOf(exportDir.rva, 40);
    const base = u32(pos + 16), count = u32(pos + 20), namesCount = u32(pos + 24);
    if (count > 65536 || namesCount > 65536) fail('export count');
    const functions = u32(pos + 28), names = u32(pos + 32), ordinals = u32(pos + 36);
    const named = new Map();
    for (let i = 0; i < namesCount; i++) {
      const ordinal = u16(offsetOf(ordinals + i * 2, 2));
      if (ordinal >= count) fail('export ordinal index');
      const name = stringAt(u32(offsetOf(names + i * 4, 4)));
      named.set(ordinal, [...(named.get(ordinal) ?? []), name]);
    }
    for (let i = 0; i < count; i++) {
      const address = u32(offsetOf(functions + i * 4, 4));
      if (!address) continue;
      const forwarder = address >= exportDir.rva && address < exportDir.rva + exportDir.size ? stringAt(address) : null;
      exports.push({ ordinal: base + i, names: named.get(i) ?? [], forwarder });
    }
  }
  return { machine, architecture: MACHINES.get(machine) ?? `machine-0x${machine.toString(16)}`, format: wide ? 'PE32+' : 'PE32', imports, exports };
}
