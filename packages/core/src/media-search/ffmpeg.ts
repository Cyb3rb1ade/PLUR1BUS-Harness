import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { mediaError } from "./errors.ts";
import type { AudioDecoderPort, FrameExtractorPort, MediaSource } from "./types.ts";

export interface FfmpegPortsOptions {
  ffmpegPath?: string; ffprobePath?: string;
  /** All temp files live in a fresh mkdtemp directory below this one and are removed after each call. */
  tempDir: string;
  timeoutMs?: number;       // per process, default 120 s
  maxBytes?: number;        // total stdout per call, default 1 GiB
  maxFrameBytes?: number;   // one encoded frame, default 16 MiB
  audioChunkSec?: number;   // PCM chunk length, default 10 s
  spawn?: typeof nodeSpawn;
}

const SCENE_THRESHOLD = 0.3;
const STDERR_CAP = 256 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Inputs may only be plain files or pipes, so a path can never turn into a network URL or a concat/subfile protocol.
// `-format_whitelist` makes ffmpeg itself refuse hls, concat, dash, sdp and the like, even if a file passes the magic-byte check.
const DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,aiff,ogg,flac,mp3,aac,flv,mpeg";
const SAFE_INPUT = ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-format_whitelist", DEMUXERS];

/**
 * Playlist-like demuxers (HLS, concat, DASH, SDP, ...) let a crafted "media" file make ffmpeg read other local files, which the
 * protocol whitelist does not stop (`file` has to stay allowed for the input itself). Only binary containers are handed to ffmpeg.
 */
export function isAllowedContainer(head: Uint8Array): boolean {
  const b = Buffer.from(head);
  const at = (o: number, s: string) => b.length >= o + s.length && b.toString("latin1", o, o + s.length) === s;
  if (at(4, "ftyp") || at(4, "moov") || at(4, "mdat") || at(4, "free") || at(4, "wide")) return true; // MP4 / MOV / M4A
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // Matroska / WebM
  if (at(0, "RIFF") || at(0, "FORM") || at(0, "OggS") || at(0, "fLaC") || at(0, "ID3") || at(0, "FLV")) return true; // AVI, WAV, AIFF, Ogg, FLAC, MP3, FLV
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return true; // MPEG audio / ADTS sync word
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xba) return true; // MPEG-PS
  return false;
}
async function sniffFile(file: string): Promise<boolean> {
  const h = await open(file, "r");
  try { const buf = Buffer.alloc(16); const { bytesRead } = await h.read(buf, 0, 16, 0); return isAllowedContainer(buf.subarray(0, bytesRead)); }
  finally { await h.close(); }
}

function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) { const c = join(dir, name + ext); if (isExecutable(c)) return c; }
  }
  return null;
}
function isExecutable(p: string): boolean {
  try { if (!statSync(p).isFile()) return false; accessSync(p, constants.X_OK); return true; } catch { return false; }
}
function resolveBinary(explicit: string | undefined, name: string): string | null {
  if (explicit !== undefined) return isExecutable(explicit) ? explicit : null;
  return findOnPath(name);
}

class Proc {
  stderr = ""; timedOut = false; tooBig = false; spawnError: Error | undefined; bytes = 0;
  readonly child: ChildProcess;
  readonly exit: Promise<number | null>;
  #timer: NodeJS.Timeout;
  readonly o: { timeoutMs: number; maxBytes: number };
  constructor(spawnFn: typeof nodeSpawn, cmd: string, args: string[], o: { timeoutMs: number; maxBytes: number }) {
    this.o = o;
    // No shell, arguments as an array, stdin closed.
    this.child = spawnFn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.exit = new Promise((res) => { this.child.once("close", (code) => res(code)); this.child.once("error", (e) => { this.spawnError = e; res(null); }); });
    this.child.stderr?.on("data", (d: Buffer) => { if (this.stderr.length < STDERR_CAP) this.stderr += d.toString("latin1"); });
    this.#timer = setTimeout(() => { this.timedOut = true; this.kill(); }, o.timeoutMs);
  }
  kill(): void { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }
  async *chunks(): AsyncGenerator<Buffer> {
    let completed = false;
    try {
      if (this.child.stdout) {
        for await (const c of this.child.stdout as AsyncIterable<Buffer>) {
          this.bytes += c.length;
          if (this.bytes > this.o.maxBytes) { this.tooBig = true; return; }
          yield c;
        }
        completed = true;
      }
    } finally { if (!completed) this.kill(); }
  }
  /** Waits for exit, releases the timer and throws a media error for timeout, size, spawn failure or non-zero exit. */
  async finish(): Promise<void> {
    const code = await this.exit; clearTimeout(this.#timer);
    if (this.timedOut) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "ffmpeg timed out", { reason: "timeout" });
    if (this.tooBig) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "ffmpeg output exceeded the size limit", { reason: "output-too-large" });
    if (this.spawnError) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "ffmpeg could not be started", { reason: "spawn-failed", detail: (this.spawnError as NodeJS.ErrnoException).code ?? "" });
    if (code !== 0) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "ffmpeg failed", { reason: "exit-code", detail: this.stderr.slice(-300) });
  }
  dispose(): Promise<unknown> { this.kill(); clearTimeout(this.#timer); return this.exit; }
}

/** Splits a concatenated PNG stream (image2pipe) by walking the chunk structure up to IEND. */
function splitPng(buf: Buffer, maxFrameBytes: number): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = []; let start = 0;
  for (;;) {
    let pos = start;
    if (buf.length - pos < 8) break;
    if (!buf.subarray(pos, pos + 8).equals(PNG_SIG)) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "unexpected frame data from ffmpeg", { reason: "bad-frame" });
    pos += 8;
    let complete = false;
    while (buf.length - pos >= 12) {
      const len = buf.readUInt32BE(pos);
      const end = pos + 12 + len;
      if (end - start > maxFrameBytes) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "frame exceeds the size limit", { reason: "frame-too-large" });
      if (buf.length < end) break;
      const isEnd = buf.toString("latin1", pos + 4, pos + 8) === "IEND";
      pos = end;
      if (isEnd) { complete = true; break; }
    }
    if (!complete) { if (buf.length - start > maxFrameBytes) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "frame exceeds the size limit", { reason: "frame-too-large" }); break; }
    frames.push(buf.subarray(start, pos)); start = pos;
  }
  return { frames, rest: buf.subarray(start) };
}

function parseShowinfo(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/showinfo.*?pts_time:\s*(-?\d+(?:\.\d+)?)/g)) out.push(Number(m[1]));
  return out;
}

export function createFfmpegPorts(opts: FfmpegPortsOptions): { frames: FrameExtractorPort | null; audio: AudioDecoderPort | null } {
  const ffmpeg = resolveBinary(opts.ffmpegPath, "ffmpeg");
  if (!ffmpeg) return { frames: null, audio: null };
  const ffmpegBin: string = ffmpeg;
  const ffprobe = resolveBinary(opts.ffprobePath, "ffprobe");
  const spawnFn = opts.spawn ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024;
  const maxFrameBytes = opts.maxFrameBytes ?? 16 * 1024 * 1024;
  const chunkSec = opts.audioChunkSec ?? 10;

  /** Resolves a source to an ffmpeg input argument; bytes sources are written to a private temp dir that `cleanup` removes. */
  async function prepareInput(src: MediaSource): Promise<{ input: string; cleanup(): Promise<void> }> {
    if ("path" in src) {
      if (typeof src.path !== "string" || src.path.length === 0 || src.path.includes("\0")) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "invalid media path", { reason: "bad-path" });
      const abs = resolve(src.path);
      if (!(await sniffFile(abs).catch(() => false))) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "container not allowed", { reason: "container-not-allowed" });
      return { input: `file:${abs}`, cleanup: async () => {} };
    }
    await mkdir(opts.tempDir, { recursive: true });
    const dir = await mkdtemp(join(opts.tempDir, "media-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
      if (!isAllowedContainer(src.bytes.subarray(0, 16))) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "container not allowed", { reason: "container-not-allowed" });
      const file = join(dir, "input.bin"); await writeFile(file, src.bytes); return { input: `file:${file}`, cleanup }; }
    catch (e) { await cleanup(); throw e; }
  }

  async function probeDuration(input: string): Promise<number | undefined> {
    if (!ffprobe) return undefined;
    const p = new Proc(spawnFn, ffprobe, ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", DEMUXERS, "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "-i", input], { timeoutMs: Math.min(timeoutMs, 30_000), maxBytes: 64 * 1024 });
    try {
      let out = ""; for await (const c of p.chunks()) out += c.toString("latin1");
      await p.finish();
      const d = Number.parseFloat(out.trim());
      return Number.isFinite(d) && d > 0 ? d : undefined;
    } catch { return undefined; } finally { await p.dispose(); }
  }

  async function runFrames(input: string, filter: string, maxFrames: number, intervalSec: number): Promise<Array<{ tsMs: number; image: Uint8Array; mime: string }>> {
    const args = [...SAFE_INPUT, "-loglevel", "info", "-nostats", "-i", input, "-an", "-sn", "-vf", `${filter},showinfo`, "-fps_mode", "vfr", "-frames:v", String(maxFrames), "-c:v", "png", "-f", "image2pipe", "pipe:1"];
    const p = new Proc(spawnFn, ffmpegBin, args, { timeoutMs, maxBytes });
    const frames: Buffer[] = [];
    try {
      let pending: Buffer = Buffer.alloc(0);
      for await (const c of p.chunks()) {
        pending = pending.length ? Buffer.concat([pending, c]) : c;
        const r = splitPng(pending, maxFrameBytes);
        frames.push(...r.frames); pending = r.rest;
        if (pending.length > maxFrameBytes) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "frame exceeds the size limit", { reason: "frame-too-large" });
      }
      await p.finish();
    } finally { await p.dispose(); }
    const ts = parseShowinfo(p.stderr);
    return frames.slice(0, maxFrames).map((f, i) => ({ tsMs: Math.round((ts[i] ?? i * intervalSec) * 1000), image: new Uint8Array(f), mime: "image/png" }));
  }

  const frames: FrameExtractorPort = {
    async *frames(src, o) {
      const { input, cleanup } = await prepareInput(src);
      let out: Array<{ tsMs: number; image: Uint8Array; mime: string }>;
      try {
        const duration = await probeDuration(input);
        // Spread maxFrames over the whole video when it is longer than interval * maxFrames.
        const interval = Math.max(o.intervalSec, duration ? duration / o.maxFrames : 0, 0.001);
        out = o.sceneDetect ? await runFrames(input, `select='eq(n,0)+gt(scene,${SCENE_THRESHOLD})'`, o.maxFrames, interval) : [];
        if (out.length === 0) out = await runFrames(input, `fps=1/${interval}`, o.maxFrames, interval);
      } finally { await cleanup(); }
      yield* out;
    },
  };

  const audio: AudioDecoderPort = {
    async *pcm(src, o) {
      const bytesPerChunk = Math.max(1, Math.floor(o.sampleRate * chunkSec)) * 4;
      const { input, cleanup } = await prepareInput(src);
      let p: Proc | undefined;
      try {
        const duration = await probeDuration(input);
        const maxSeconds = duration ? Math.min(o.maxSeconds, Math.ceil(duration)) : o.maxSeconds;
        const args = [...SAFE_INPUT, "-loglevel", "error", "-t", String(maxSeconds), "-i", input, "-vn", "-sn", "-ac", "1", "-ar", String(o.sampleRate), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"];
        p = new Proc(spawnFn, ffmpegBin, args, { timeoutMs, maxBytes });
        let pending: Buffer = Buffer.alloc(0); let sampleIdx = 0;
        const emit = (b: Buffer) => {
          const bytes = new Uint8Array(b.length); bytes.set(b);
          const samples = new Float32Array(bytes.buffer, 0, b.length / 4); // f32le assumes a little-endian host
          const r = { startMs: Math.round((sampleIdx / o.sampleRate) * 1000), samples };
          sampleIdx += samples.length; return r;
        };
        for await (const c of p.chunks()) {
          pending = pending.length ? Buffer.concat([pending, c]) : c;
          while (pending.length >= bytesPerChunk) { yield emit(pending.subarray(0, bytesPerChunk)); pending = pending.subarray(bytesPerChunk); }
        }
        await p.finish();
        const whole = pending.length - (pending.length % 4);
        if (whole > 0) yield emit(pending.subarray(0, whole));
      } finally {
        await p?.dispose();
        await cleanup();
      }
    },
  };

  return { frames, audio };
}
