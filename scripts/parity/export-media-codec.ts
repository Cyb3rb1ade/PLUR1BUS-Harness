import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { spawn } from "node:child_process";
import { binaryExtensions, createFfmpegPorts, isAllowedContainer, isSpawnableName } from "../../packages/core/src/media-search/ffmpeg.ts";
import { exporterMain } from "./lib.mjs";

const MP4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const PNG = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");

async function testPort(name: string) {
  const root = mkdtempSync(join(tmpdir(), "media-codec-v-"));
  const plans: Array<{ args: string[]; shell: unknown }> = [];
  const fake = ((_bin: string, argv: string[], opts: { shell?: unknown }) => {
    plans.push({ args: argv.map(arg => arg.startsWith("file:") ? "file:<input>" : arg), shell: opts.shell });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
      signalCode: null as string | null, kill() { return true; },
    });
    queueMicrotask(() => {
      if (argv.includes("-show_entries")) child.stdout.end("12.5\n");
      else if (argv.includes("f32le")) {
        const data = Buffer.alloc(16);
        [0, 0.25, -0.5, 1].forEach((sample, i) => data.writeFloatLE(sample, i * 4));
        child.stdout.write(data.subarray(0, 6));
        child.stdout.end(data.subarray(6));
      } else if (argv.some(arg => arg.includes("gt(scene")) && name === "fallback") child.stdout.end();
      else {
        child.stderr.write("showinfo pts_time:0\nshowinfo pts_time:2.5\n");
        child.stdout.write(PNG.subarray(0, 6));
        child.stdout.end(Buffer.concat([PNG.subarray(6), PNG]));
      }
      child.stderr.end();
      child.exitCode = 0;
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
  try {
    const ports = createFfmpegPorts({
      ffmpegPath: process.execPath, ffprobePath: process.execPath, tempDir: root, spawn: fake,
      audioChunkSec: 0.00025,
    });
    const out: unknown[] = [];
    if (name === "pcm") {
      for await (const chunk of ports.audio!.pcm({ bytes: Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0]) }, { sampleRate: 8000, mono: true, maxSeconds: 4 })) {
        out.push({ startMs: chunk.startMs, samples: [...chunk.samples] });
      }
    } else {
      for await (const frame of ports.frames!.frames({ bytes: MP4 }, { intervalSec: 1, maxFrames: 2, sceneDetect: name === "fallback" })) {
        out.push({ tsMs: frame.tsMs, mime: frame.mime, bytes: [...frame.image] });
      }
    }
    return { name, plans, out };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function buildMediaCodecVectors() {
  const headers = [
    ["mp4", [...MP4]], ["mov", [0, 0, 0, 8, 109, 111, 111, 118]], ["wav", [82, 73, 70, 70]],
    ["webm", [26, 69, 223, 163]], ["ogg", [79, 103, 103, 83]], ["mpeg", [0, 0, 1, 186]],
    ["aac", [255, 241]], ["document", [116, 101, 120, 116]], ["empty", []],
    ["short", [26, 69, 223]], ["unknown", [0, 0, 0, 8, 97, 98, 99, 100]],
  ].map(([name, bytes]) => ({ name, bytes, allowed: isAllowedContainer(Uint8Array.from(bytes as number[])) }));
  const paths = ["ffmpeg.exe", "ffmpeg", "ffmpeg.cmd", "C:\\Tools\\ffmpeg.Exe", "/opt/ffmpeg.com", "x.exe."];
  return { codec: { headers, names: (["win32", "darwin", "linux"] as const).map(platform => ({
    platform, extensions: binaryExtensions(platform), paths: paths.map(path => ({ path, allowed: isSpawnableName(path, platform) })),
  })), ports: await Promise.all(["frames", "fallback", "pcm"].map(testPort)) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "media", build: buildMediaCodecVectors });
}
