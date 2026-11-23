import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { processVideo, videoFormat } from "../../packages/media/src/video.ts";
import type { VideoFormat } from "../../packages/media/src/types.ts";
import { exporterMain } from "./lib.mjs";

const validProbe = {
  streams: [
    { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
    { codec_type: "audio" },
  ],
  format: { duration: "2.5" },
};

export async function recordVideoProcess() {
  const cases = [
    { name: "mp4-with-prompt", format: "mp4", prompt: "blue sky", probe: validProbe },
    {
      name: "mov-silent", format: "mov",
      probe: { ...validProbe, streams: validProbe.streams.slice(0, 1) },
    },
    { name: "webm-remux-failed", format: "webm", probe: validProbe, failStep: 2 },
    {
      name: "invalid-frame-rate", format: "mp4",
      probe: { ...validProbe, streams: [{ ...validProbe.streams[0], avg_frame_rate: "0/0" }] },
    },
    { name: "probe-stdout-over-limit", format: "mp4", probe: validProbe, probeBytes: 1048577 },
    { name: "pre-cancelled", format: "mp4", probe: validProbe, cancelled: true },
  ] as const;
  const recorded = [];
  for (const item of cases) {
    const input = `/fixture/input.${item.format}`;
    const output = `/fixture/clean.${item.format}`;
    const poster = "/fixture/poster.png";
    const commands: { program: string; args: string[] }[] = [];
    const ac = new AbortController();
    if ("cancelled" in item) ac.abort();
    const spawn = mock.method(childProcess, "spawn", (program: string, args: string[]) => {
      commands.push({ program, args });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        kill() { return true; },
      });
      const step = commands.length;
      queueMicrotask(() => {
        if (program === "ffprobe") {
          child.stdout.emit("data", "probeBytes" in item
            ? Buffer.alloc(item.probeBytes)
            : Buffer.from(JSON.stringify(item.probe)));
        }
        child.emit("close", "failStep" in item && step === item.failStep ? 1 : 0);
      });
      return child;
    });
    syncBuiltinESMExports();
    let expected: unknown;
    try {
      expected = await processVideo(input, output, poster, {
        format: item.format as VideoFormat,
        ...("prompt" in item ? { prompt: item.prompt } : {}),
        signal: ac.signal,
      });
    } catch (error) {
      const cause = error as { code?: string; name: string };
      expected = { error: cause.name === "AbortError" ? "cancelled" : cause.code };
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
    recorded.push({ ...item, input, output, poster, commands, expected });
  }
  const containers = [
    Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]),
    Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  ")]),
    Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm")]),
    Buffer.from("not-video"),
  ].map((bytes) => {
    let expected: string;
    try {
      expected = videoFormat(bytes);
    } catch (error) {
      expected = (error as { code: string }).code;
    }
    return { bytes: [...bytes], expected };
  });
  return { "video-process": { source: "packages/media/src/video.ts", cases: recorded, containers } };

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordVideoProcess });
}
