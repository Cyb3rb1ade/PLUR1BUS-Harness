/** B1 reserves a private output before paid work; failed captures remove only their own reserved file. */
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Hold an exclusive output capability; commit once after redaction/validation, close in every exit path. */
export async function reserveCodingPublication(path: string): Promise<{
  commit(text: string): Promise<void>;
  close(): Promise<void>;
}> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const handle = await open(output, "wx", 0o600);
  const identity = await handle.stat();
  let published = false;
  let closed = false;
  return {
    async commit(text) {
      if (closed || published || !text || Buffer.byteLength(text) > 32 * 1024 ** 2) {
        throw new Error("coding publication refused");
      }
      await handle.writeFile(text, "utf8");
      await handle.sync();
      published = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await handle.close();
      } finally {
        if (!published) {
          const current = await lstat(output).catch(() => undefined);
          if (current?.dev === identity.dev && current.ino === identity.ino) await unlink(output);
        }
      }
    },
  };
}
