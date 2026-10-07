import { MediaError } from './types.ts';
/** PNG iTXt supports UTF-8. No EXIF dependency or lossy re-encoding is needed. */
export function embedPng(bytes: Uint8Array, metadata: unknown): Uint8Array {
  const b = Buffer.from(bytes);
  if (!b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new MediaError('invalid_response');
  let end = 8;
  while (end + 12 <= b.length) {
    const length = b.readUInt32BE(end); const type = b.toString('ascii', end + 4, end + 8);
    if (end + 12 + length > b.length) throw new MediaError('invalid_response');
    if (type === 'IEND') break;
    end += 12 + length;
  }
  if (end + 12 !== b.length || b.toString('ascii', end + 4, end + 8) !== 'IEND') throw new MediaError('invalid_response');
  const payload = Buffer.concat([Buffer.from('plur1bus\0\0\0\0\0'), Buffer.from(JSON.stringify(metadata))]);
  const chunk = Buffer.alloc(payload.length + 12); chunk.writeUInt32BE(payload.length); chunk.write('iTXt', 4); payload.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([b.subarray(0, end), chunk, b.subarray(end)]);
}
