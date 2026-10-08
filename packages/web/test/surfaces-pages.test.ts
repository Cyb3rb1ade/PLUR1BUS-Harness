import assert from "node:assert/strict";
import { before, after, describe, test } from "node:test";
import { setup, teardown, withApp, openRoute, browserSkip } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
before(setup);
after(teardown);
const outputId = "00000000-0000-4000-8000-000000000001";
const output = {
  id: outputId,
  agentId: "main",
  prompt: "Synthetic forest",
  createdAt: 100,
  metadata: { adapter: "fake", model: "fixture" },
  files: [{ path: "0.png", bytes: 3, format: "png" }],
};
describe(
  "surfaces pages against authenticated mock API",
  { skip: browserSkip },
  () => {
    for (const [route, method, result, empty, title] of [
      [
        "media",
        "media.output.list",
        { outputs: [output] },
        { outputs: [] },
        "Media",
      ],
      [
        "projects",
        "project.list",
        {
          projects: [
            {
              id: "prj_1",
              name: "Synthetic project",
              owner: "owner",
              members: [],
              agents: [],
              archivedAt: null,
            },
          ],
        },
        { projects: [] },
        "Projects",
      ],
      [
        "identities",
        "identity.link.list",
        {
          humanId: "owner",
          links: [
            {
              id: "link1",
              channel: "telegram",
              accountId: "bot",
              userId: "42",
            },
          ],
          pairings: [],
        },
        { humanId: "owner", links: [], pairings: [] },
        "My identities",
      ],
    ] as const) {
      test(`${route}: success, empty, error and forbidden`, async () => {
        for (const scenario of [
          "success",
          "empty",
          "error",
          "forbidden",
        ] as const)
          await withApp({}, async (app) => {
            app.server.rpc.handle(method, () => result, {
              write: false,
              empty,
            });
            app.server.rpc.scenario(method, scenario);
            app.server.rpc.handle(
              "media.output.get",
              () => ({
                manifest: output,
                data: "UE5H",
                mimeType: "image/png",
                canShare: false,
              }),
              { write: false },
            );
            await openRoute(app.page, `#/${route}`);
            await app.page
              .getByRole("heading", { name: title, exact: true })
              .waitFor();
            if (scenario === "empty")
              await app.page
                .getByText("No entries yet", { exact: true })
                .waitFor();
            if (scenario === "forbidden")
              await app.page.locator('[data-state="forbidden"]').waitFor();
            if (scenario === "error")
              await app.page.locator('[data-state="error"]').waitFor();
            if (scenario === "success" && route === "media")
              await app.page
                .getByText("Synthetic forest", { exact: true })
                .waitFor();
            if (scenario === "success" && route === "projects")
              await app.page
                .getByRole("link", { name: "Synthetic project" })
                .waitFor();
            if (scenario === "success" && route === "identities")
              await app.page
                .getByText("telegram · bot · 42", { exact: false })
                .waitFor();
          });
      });
    }
    test("media download and deletion are bound to a stored id and confirmation", async () =>
      withApp({}, async (app) => {
        let deleted = false;
        app.server.rpc.handle(
          "media.output.list",
          () => ({ outputs: deleted ? [] : [output] }),
          { write: false },
        );
        app.server.rpc.handle(
          "media.output.get",
          () => ({
            manifest: output,
            data: "UE5H",
            mimeType: "image/png",
            canShare: false,
          }),
          { write: false },
        );
        app.server.rpc.handle("media.output.delete", (p) => {
          assert.deepEqual(p, { id: outputId });
          deleted = true;
          return { deleted: true };
        });
        await openRoute(app.page, "#/media");
        await app.page.getByText("Synthetic forest", { exact: true }).click();
        await app.page.getByRole("link", { name: "Download" }).waitFor();
        await app.page
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        assert.equal(deleted, false);
        await app.page
          .getByRole("dialog")
          .last()
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        await app.page.getByText("No entries yet").waitFor();
        assert.equal(deleted, true);
      }));
    test("pairing code exists only in issuance response and disappears on navigation", async () =>
      withApp({}, async (app) => {
        app.server.rpc.handle(
          "identity.link.list",
          () => ({ humanId: "owner", links: [], pairings: [] }),
          { write: false },
        );
        app.server.rpc.handle("identity.link.request", () => ({
          id: "p1",
          code: "ABCDEFGH",
          expiresAt: 1000,
        }));
        await openRoute(app.page, "#/identities");
        await app.page
          .getByRole("button", { name: "Issue pairing code" })
          .click();
        await app.page
          .getByText("One-time code: ABCDEFGH", { exact: false })
          .waitFor();
        await app.page
          .getByRole("link", { name: "Projects", exact: true })
          .click();
        await app.page
          .getByRole("heading", { name: "Projects", exact: true })
          .waitFor();
        await app.page.evaluate(() => {
          location.hash = "#/identities";
        });
        await app.page
          .getByRole("heading", { name: "My identities", exact: true })
          .waitFor();
        assert.equal(await app.page.getByText(/ABCDEFGH/).count(), 0);
      }));
    test("project trace shows spans and redacted previews", async () =>
      withApp({}, async (app) => {
        app.server.rpc.handle(
          "project.list",
          () => ({
            projects: [
              {
                id: "prj_1",
                name: "Synthetic project",
                owner: "owner",
                members: [{ userId: "owner", role: "lead" }],
                agents: ["a"],
                archivedAt: null,
              },
            ],
          }),
          { write: false },
        );
        app.server.rpc.handle(
          "collab.trace.list",
          () => ({
            traces: [
              {
                traceId: "a".repeat(32),
                projectId: "prj_1",
                status: "succeeded",
                spans: [
                  {
                    spanId: "b".repeat(16),
                    parentSpanId: null,
                    agentId: "a",
                    startedAt: 100,
                    endedAt: 200,
                    status: "succeeded",
                    inputTokens: 10,
                    outputTokens: 20,
                    costEstimate: 0,
                    inputPreview: "[redacted] question",
                    outputPreview: "Synthetic answer",
                  },
                ],
              },
            ],
          }),
          { write: false },
        );
        await openRoute(app.page, "#/projects/prj_1");
        await app.page
          .getByRole("heading", { name: "Collaboration traces" })
          .waitFor();
        await app.page
          .locator("details")
          .first()
          .locator(":scope > summary")
          .click();
        await app.page.getByText("Tokens: 30", { exact: false }).waitFor();
      }));
  },
);
