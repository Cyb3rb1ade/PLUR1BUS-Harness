import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { archiveFolder } from "../src/pages/extensions/folder.ts";

const file = (path: string, text: string) => {
  const f = new File([text], path.split("/").at(-1)!);
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
};
test("browser folder archive is a UTF-8 store ZIP with real CRCs, relative paths and no directory entries", async () => {
  const files = [file("source/SKILL.md", "# Local skill\n"), file("source/scripts/run.sh", "#!/bin/sh\ntrue\n")];
  const blob = await archiveFolder(files);
  const archive = Buffer.from(await blob.arrayBuffer());
  let offset = 0;
  for (const input of files) {
    assert.equal(archive.readUInt32LE(offset), 0x04034b50);
    assert.equal(archive.readUInt16LE(offset + 6), 0x800);
    const length = archive.readUInt32LE(offset + 18),
      nameLength = archive.readUInt16LE(offset + 26);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
    assert.equal(name, input.webkitRelativePath.slice(7));
    const data = archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + length);
    assert.equal(data.toString(), await input.text());
    assert.equal(archive.readUInt32LE(offset + 14), crc32(data));
    offset += 30 + nameLength + length;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 10), 2);
  assert.equal(archive.readUInt32LE(end + 16), offset);
});
test("folder packaging refuses unsafe or ambiguous paths, budgets and cancellation", async () => {
  await assert.rejects(archiveFolder([file("source/../outside", "x")]));
  await assert.rejects(archiveFolder([file("source/CON", "x")]));
  await assert.rejects(archiveFolder([file("source/A.txt", "a"), file("source/a.txt", "b")]));
  await assert.rejects(archiveFolder([file("source/SKILL.md", "12345")], { maxBytes: 4 }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(archiveFolder([file("source/SKILL.md", "x")], { signal: controller.signal }));
});
