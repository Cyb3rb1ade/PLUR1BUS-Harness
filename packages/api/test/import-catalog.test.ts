/** Real HTTP catalog metadata is human-only and locality is server-derived. */
import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_CATALOG } from "../../core/src/import/types.ts";
import { IMPORT_ROUTES } from "../src/import-routes.ts";
import { validate } from "./openapi-validate.ts";
import { addUser, login, loginAs, raw, start } from "./helpers.ts";

test("source catalog exposes only canonical display metadata and trusted locality capability to Owner/Admin people", async (t) => {
  const previous = process.env.PLUR1BUS_CONTAINER;
  process.env.PLUR1BUS_CONTAINER = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.PLUR1BUS_CONTAINER;
    else process.env.PLUR1BUS_CONTAINER = previous;
  });
  const h = await start();
  t.after(() => h.close());
  assert.equal((await raw(h, { path: "/api/v1/import/sources" })).status, 401);
  const { cookie } = await login(h);
  const catalog = await raw(h, {
    path: "/api/v1/import/sources",
    headers: { cookie, "x-forwarded-for": "203.0.113.1" },
  });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.json, { sources: SOURCE_CATALOG, hostPathsAllowed: true });
  for (const role of ["admin", "member", "viewer", "operator"] as const) {
    await addUser(h, { id: role, username: role, role });
    const who = await loginAs(h, role);
    const result = await raw(h, { path: "/api/v1/import/sources", headers: { cookie: who.cookie } });
    assert.equal(result.status, role === "admin" ? 200 : 403);
    if (role === "admin") assert.equal(result.json.hostPathsAllowed, true);
  }
});

test("container SSH host suggestion comes only from the inherited container flag and has a closed shape", async (t) => {
  const previous = process.env.PLUR1BUS_CONTAINER;
  t.after(() => {
    if (previous === undefined) delete process.env.PLUR1BUS_CONTAINER;
    else process.env.PLUR1BUS_CONTAINER = previous;
  });
  for (const container of [false, true]) {
    process.env.PLUR1BUS_CONTAINER = container ? "1" : "0";
    const h = await start();
    try {
      const { cookie } = await login(h);
      const response = await raw(h, {
        path: "/api/v1/import/sources?container=1",
        headers: { cookie, "x-plur1bus-container": "1", "x-forwarded-host": "host.docker.internal" },
      });
      assert.equal(response.status, 200);
      const schema = IMPORT_ROUTES[0]!.success.schema;
      const doc = { components: { schemas: {} } };
      assert.deepEqual(validate(schema, response.json, doc), []);
      for (const suggestion of [
        { host: "other.example", reason: "container-host" },
        { host: "host.docker.internal", reason: "client-request" },
        { host: "host.docker.internal", reason: "container-host", allowPrivate: true },
      ])
        assert.ok(validate(schema, { ...response.json, sshHostSuggestion: suggestion }, doc).length > 0);
      assert.deepEqual(
        response.json.sshHostSuggestion,
        container ? { host: "host.docker.internal", reason: "container-host" } : undefined,
      );
      assert.deepEqual(
        Object.keys(response.json).sort(),
        container ? ["hostPathsAllowed", "sources", "sshHostSuggestion"] : ["hostPathsAllowed", "sources"],
      );
    } finally {
      await h.close();
    }
  }
});
