import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csrfToken, fakeCore, login, raw, start } from "./helpers.ts";

const multipart = Buffer.from(
  '--snapshot-boundary\r\nContent-Disposition: form-data; name="file"; filename="snapshot.tar.gz"\r\nContent-Type: application/gzip\r\n\r\nfixture-snapshot\r\n--snapshot-boundary--\r\n',
);
const contentType = "multipart/form-data; boundary=snapshot-boundary";
test("snapshot staging is a separate private owner-bound capability domain", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "import-snapshot-http-")),
    h = await start({ home });
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  const { cookie } = await login(h);
  const response = await raw(h, {
    method: "POST",
    path: "/api/v1/import/snapshots",
    headers: { cookie, "x-csrf-token": await csrfToken(h, cookie), "content-type": contentType },
    body: multipart,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ["expiresAt", "sha256", "snapshotId"]);
  assert.match(response.json.snapshotId, /^[A-Za-z0-9_-]{43}$/);
  const file = join(home, "run", "import-snapshots", response.json.snapshotId);
  assert.equal((await readFile(file)).toString(), "fixture-snapshot");
  assert.equal(JSON.parse(await readFile(file + ".json", "utf8")).userId, "local-owner");
  await assert.rejects(readFile(join(home, "run", "uploads", response.json.snapshotId)));
});
test("native import scope and extension scope are explicitly separate", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "import-snapshot-scopes-")),
    core = fakeCore(),
    h = await start({ home, core });
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  const token = "I".repeat(43);
  let scopes = ["extensions.manage"];
  core.serviceCall = async (method) => {
    if (method === "admin.api.desktop.token")
      return { deviceId: "native", userId: "person", expiresAt: h.clock.now() + 100_000, scopes } as never;
    if (method === "admin.api.person.resolve")
      return { person: { userId: "person", kind: "person", role: "owner", disabled: false, version: 1 } } as never;
    throw new Error("unexpected service method");
  };
  const post = (path: string) =>
    raw(h, {
      method: "POST",
      path,
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body: multipart,
    });
  assert.equal((await post("/api/v1/import/snapshots")).status, 403);
  scopes = ["imports.manage"];
  assert.equal((await post("/api/v1/import/snapshots")).status, 200);
  assert.equal((await post("/api/v1/extensions/upload")).status, 403);
});
