import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaError } from './types.ts';
import type { VideoFormat } from './types.ts';
export interface VideoInfo { durationSeconds: number; width: number; height: number; fps: number; audio: boolean }
export type VideoProcessor = (input: string, output: string, poster: string, options: { format: VideoFormat; prompt?: string; signal?: AbortSignal }) => Promise<VideoInfo>;
/** Only supported containers; declared HTTP MIME and extensions are never trusted. */
export function videoFormat(bytes: Uint8Array): VideoFormat {
  const b = Buffer.from(bytes);
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'mov';
    if (['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','M4V ','dash'].includes(brand)) return 'mp4';
  }
  if (b.length >= 8 && b.readUInt32BE(0) === 0x1a45dfa3 && b.includes(Buffer.from('webm'))) return 'webm';
  throw new MediaError('invalid_response');
}
async function run(program: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore','pipe','ignore'], ...(signal ? { signal } : {}), windowsHide: true });
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.on('error', () => reject(new MediaError(signal?.aborted ? signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' : 'backend_unavailable')));
    child.on('close', code => code === 0 && size <= 1024 * 1024 ? resolve(Buffer.concat(chunks).toString()) : reject(new MediaError(signal?.aborted ? signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' : 'invalid_response')));
  });
}
/** Local ffmpeg/ffprobe, no shell and no network protocols. Remux clean tracks; drop all inherited global/stream/chapter metadata. */
export const processVideo: VideoProcessor = async (input, output, poster, options) => {
  const protocol = ['-protocol_whitelist','file,pipe'];
  const doc = JSON.parse(await run('ffprobe', ['-v','error', ...protocol, '-show_streams','-show_format','-of','json',input], options.signal)) as { streams: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string }[]; format: { duration?: string } };
  const video = doc.streams.find(s => s.codec_type === 'video');
  const durationSeconds = Number(doc.format.duration), width = video?.width ?? 0, height = video?.height ?? 0;
  const [num, den] = (video?.avg_frame_rate ?? '0/1').split('/').map(Number); const fps = num! / den!;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !width || !height || !Number.isFinite(fps) || fps <= 0) throw new MediaError('invalid_response');
  const metadata = options.prompt === undefined ? [] : ['-metadata', `comment=${options.prompt}`];
  await run('ffmpeg',['-v','error','-nostdin', ...protocol, '-i',input,'-map','0:v:0','-map','0:a?','-map_metadata','-1','-map_metadata:s','-1','-map_chapters','-1','-c','copy', ...metadata, '-f',options.format === 'mp4' ? 'mp4' : options.format, '-y',output],options.signal);
  await run('ffmpeg',['-v','error','-nostdin', ...protocol,'-i',output,'-map','0:v:0','-frames:v','1','-vf','scale=320:-2','-map_metadata','-1','-y',poster],options.signal);
  return { durationSeconds, width, height, fps, audio: doc.streams.some(s => s.codec_type === 'audio') };
};
/** Clean private reference bytes before submission. Temporary files never enter manifests. */
export async function sanitizeVideo(bytes: Uint8Array, processor: VideoProcessor = processVideo, signal?: AbortSignal): Promise<{ bytes: Uint8Array; format: VideoFormat }> {
  const format = videoFormat(bytes); const root = await mkdtemp(join(tmpdir(),'p1-video-'));
  try {
    const input = join(root,`input.${format}`), output = join(root,`clean.${format}`);
    await writeFile(input,bytes,{mode:0o600}); await processor(input,output,join(root,'poster.png'),{format,...(signal ? {signal} : {})});
    return { bytes: await readFile(output), format };
  } finally { await rm(root,{recursive:true,force:true}); }
}
