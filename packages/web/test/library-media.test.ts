import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const IMG = "00000000-0000-4000-8000-000000000001";
const IMG2 = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-0000000000a1";
const OUT = "00000000-0000-4000-8000-0000000000b1";

const outputs = [
  { id: IMG, agentId: "main", prompt: "A mountain", kind: "image", createdAt: 1000, metadata: { adapter: "cloud" }, files: [{ path: "0.png", format: "png", bytes: 100 }] },
  { id: IMG2, agentId: "main", prompt: "A lake", kind: "image", createdAt: 2000, metadata: { adapter: "cloud" }, files: [{ path: "0.png", format: "png", bytes: 100 }] },
];
const adapters = [
  { id: "cloud", model: "img-1", capabilities: { generate: true, edit: true, inpaint: true } },
  { id: "box", model: "local-1", local: true, capabilities: { generate: true, edit: false, inpaint: false } },
  { id: "vid", model: "vid-1", capabilities: { generate: false, edit: false, inpaint: false,
    video: { textToVideo: true, imageToVideo: false, videoToVideo: false, durationSeconds: [2, 10], resolutions: ["720p", "1080p"], fps: [24, 30], audio: true } } },
];

type Calls = { method: string; params: any }[];
function serve(app: App, extra: (rpc: App["server"]["rpc"]) => void = () => {}): void {
  const { rpc } = app.server;
  rpc.handle("media.output.list", () => ({ outputs }), { write: false });
  rpc.handle("media.adapters.list", () => ({ adapters }), { write: false });
  rpc.handle("media.job.list", () => ({ jobs: [] }), { write: false });
  rpc.handle("media.preferences.get", () => ({ global: false, agents: {} }), { write: false });
  extra(rpc);
}
const calls = (app: App, method: string): Calls => app.server.rpc.calls.filter((c) => c.method === method) as Calls;

describe("Library: generate", opts, () => {
  test("a cloud adapter asks before sending, then queues media.generate", async () => {
    await withApp({}, async (app) => {
      serve(app, (rpc) => rpc.handle("media.generate", () => ({ jobId: JOB }), { write: true }));
      await openRoute(app.page, "#/library");
      await app.page.getByRole("button", { name: "Generate", exact: true }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByLabel("Prompt", { exact: true }).fill("a red fox");
      await dialog.getByLabel("Number of images").fill("2");
      await dialog.getByRole("button", { name: "Generate", exact: true }).click();

      await app.page.getByRole("dialog").last().getByText("Send to a cloud provider?").waitFor();
      await app.page.getByText("sent to the cloud adapter cloud").waitFor();
      assert.equal(calls(app, "media.generate").length, 0, "nothing is sent before the confirmation");
      await app.page.getByRole("button", { name: "Send and generate" }).click();

      await app.page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0);
      assert.deepEqual(calls(app, "media.generate").map((c) => c.params), [
        { agentId: "main", adapter: "cloud", kind: "image", request: { prompt: "a red fox", n: 2 } },
      ]);
    });
  });

  test("a local adapter sends without a cloud prompt; video parameters come from the adapter", async () => {
    await withApp({}, async (app) => {
      serve(app, (rpc) => rpc.handle("media.generate", () => ({ jobId: JOB }), { write: true }));
      await openRoute(app.page, "#/library");
      await app.page.getByRole("button", { name: "Generate", exact: true }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByLabel("Adapter and model").selectOption("box");
      assert.equal(await dialog.getByText(/cost|USD/i).count(), 0, "no money is shown (no money dimension since 2026-10-19)");
      await dialog.getByLabel("Prompt", { exact: true }).fill("calm lake");
      await dialog.getByRole("button", { name: "Generate", exact: true }).click();
      await app.page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0);
      assert.equal(calls(app, "media.generate").length, 1);

      await app.page.getByRole("button", { name: "Generate", exact: true }).click();
      const again = app.page.getByRole("dialog");
      await again.getByLabel("Kind").selectOption("video");
      // Fields come from the advertised ranges and lists, not from a fixed provider form.
      await again.getByLabel("Duration in seconds").fill("12");
      await again.getByLabel("Prompt", { exact: true }).fill("fox running");
      await again.getByRole("button", { name: "Generate", exact: true }).click();
      await again.getByText("between 2 and 10").waitFor();
      await again.getByLabel("Duration in seconds").fill("4");
      await again.getByLabel("Resolution").selectOption("1080p");
      await again.getByLabel("With audio").check();
      await again.getByRole("button", { name: "Generate", exact: true }).click();
      await app.page.getByRole("button", { name: "Send and generate" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0);
      assert.deepEqual(calls(app, "media.generate")[1]!.params, {
        agentId: "main", adapter: "vid", kind: "video", request: { prompt: "fox running", durationSeconds: 4, resolution: "1080p", audio: true },
      });
    });
  });

  test("only-local-models rule, budget and unavailable adapter are shown with their codes", async () => {
    const failures: [() => never, string, string][] = [
      [() => { throw rpcError("E_MEDIA_PRIVACY", "pin"); }, "only local models", "E_MEDIA_PRIVACY"],
      [() => { throw rpcError("E_DENIED", "media budget exceeded", "budget_exceeded"); }, "media budget is used up", "budget_exceeded"],
      [() => { throw rpcError("E_NOT_AVAILABLE", "media request refused", "backend_unavailable"); }, "adapter is not available", "backend_unavailable"],
      [() => { throw rpcError("E_MEDIA_LICENSE", "licence"); }, "licence of this model", "E_MEDIA_LICENSE"],
    ];
    for (const [fail, text, code] of failures) {
      await withApp({}, async (app) => {
        serve(app, (rpc) => rpc.handle("media.generate", fail, { write: true }));
        await openRoute(app.page, "#/library");
        await app.page.getByRole("button", { name: "Generate", exact: true }).click();
        const dialog = app.page.getByRole("dialog");
        await dialog.getByLabel("Adapter and model").selectOption("box");
        await dialog.getByLabel("Prompt", { exact: true }).fill("x");
        await dialog.getByRole("button", { name: "Generate", exact: true }).click();
        const alert = dialog.getByRole("alert");
        await alert.getByText(text, { exact: false }).waitFor();
        assert.match((await alert.textContent()) ?? "", new RegExp(code));
        if (code === "E_MEDIA_PRIVACY") await expectAxeClean(app.page, "generate dialog with a privacy failure");
      });
    }
  });

  test("no adapter at all explains itself; the dialog is axe clean", async () => {
    await withApp({}, async (app) => {
      serve(app, (rpc) => rpc.handle("media.adapters.list", () => ({ adapters: [] }), { write: false }));
      await openRoute(app.page, "#/library");
      await app.page.getByRole("button", { name: "Generate", exact: true }).click();
      await app.page.getByText("No adapter is available").waitFor();
      await expectAxeClean(app.page, "generate dialog without adapters");
    });
    await withApp({}, async (app) => {
      serve(app);
      await openRoute(app.page, "#/library");
      await app.page.getByRole("button", { name: "Generate", exact: true }).click();
      await app.page.getByLabel("Prompt", { exact: true }).waitFor();
      await expectAxeClean(app.page, "generate dialog");
    });
  });
});

describe("Library: edit", opts, () => {
  test("operations follow the adapter; inpainting needs a mask and sends media.edit", async () => {
    await withApp({}, async (app) => {
      serve(app, (rpc) => rpc.handle("media.edit", () => ({ jobId: JOB }), { write: true }));
      await openRoute(app.page, "#/library");
      await app.page.getByRole("button", { name: "Edit", exact: true }).first().click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByLabel("Operation").waitFor();
      const ops = await dialog.getByLabel("Operation").locator("option").allTextContents();
      assert.deepEqual(ops, ["Edit with a prompt", "Inpainting (replace the masked area)"]);
      // Adapters that do not edit are not offered at all.
      assert.deepEqual(await dialog.getByLabel("Adapter and model").locator("option").allTextContents(), ["cloud · img-1"]);

      await dialog.getByLabel("Operation").selectOption("inpaint");
      await dialog.getByLabel("Prompt", { exact: true }).fill("add snow");
      await dialog.getByRole("button", { name: "Start edit" }).click();
      await dialog.getByText("Choose a mask", { exact: true }).last().waitFor();
      await dialog.getByLabel("Mask (an image from the library)").selectOption(IMG2);
      await dialog.getByRole("button", { name: "Start edit" }).click();
      await app.page.getByRole("button", { name: "Send and generate" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0);
      const sent = calls(app, "media.edit").map((c) => c.params);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].adapter, "cloud");
      assert.equal(sent[0].request.prompt, "add snow");
      assert.equal(sent[0].request.maskId, IMG2);
      assert.equal(sent[0].request.referenceIds.length, 1);
    });
  });

  test("nothing to edit with: the dialog says so", async () => {
    await withApp({}, async (app) => {
      serve(app, (rpc) => rpc.handle("media.adapters.list", () => ({ adapters: [adapters[1]] }), { write: false }));
      await openRoute(app.page, "#/library");
      await app.page.getByRole("button", { name: "Edit", exact: true }).first().click();
      await app.page.getByText("No adapter offers an edit for this medium.").waitFor();
    });
  });
});

describe("Library: job bar", opts, () => {
  const running = (fraction: number, state = "running") => ({
    id: JOB, kind: "image", agentId: "main", adapter: "cloud", operation: "generate", state, progress: { fraction }, createdAt: 10, updatedAt: 11,
    ...(state === "succeeded" ? { outputId: IMG } : {}),
  });

  test("progress comes from job.get after an event, cancel works, the result opens", async () => {
    await withApp({}, async (app) => {
      let job: ReturnType<typeof running> = running(0.4);
      serve(app, (rpc) => {
        rpc.handle("media.job.list", () => ({ jobs: [job] }), { write: false });
        rpc.handle("media.job.get", () => job, { write: false });
        rpc.handle("media.job.cancel", () => { job = running(0.5, "cancelled"); return { cancelled: true }; }, { write: true });
        rpc.handle("media.output.get", () => ({ manifest: outputs[0], data: "UE5H", mimeType: "image/png", canShare: false }), { write: false });
      });
      app.server.events.enable();
      await openRoute(app.page, "#/library");
      const bar = app.page.getByRole("region", { name: "Jobs" });
      await bar.getByText("1 jobs running").waitFor();
      assert.equal(await bar.getByRole("progressbar").getAttribute("value"), "40");

      // The event is only a hint: the new value must come from media.job.get.
      job = running(0.8);
      app.server.events.push({ event: "media.job.progress", data: { jobId: JOB, agentId: "main", state: "running", fraction: 0.1 } });
      await app.page.waitForFunction(() => document.querySelector(".libmedia-jobs progress")?.getAttribute("value") === "80");
      await expectAxeClean(app.page, "job bar with a running job");

      job = running(1, "succeeded");
      app.server.events.push({ event: "media.job.finished", data: { jobId: JOB, agentId: "main", state: "succeeded", fraction: 1 } });
      await bar.getByRole("button", { name: "Open result" }).click();
      await app.page.getByRole("dialog").getByText("A mountain").first().waitFor();
    });
  });

  test("cancel calls media.job.cancel", async () => {
    await withApp({}, async (app) => {
      let job = running(0.2);
      serve(app, (rpc) => {
        rpc.handle("media.job.list", () => ({ jobs: [job] }), { write: false });
        rpc.handle("media.job.get", () => job, { write: false });
        rpc.handle("media.job.cancel", () => { job = running(0.2, "cancelled"); return { cancelled: true }; }, { write: true });
      });
      await openRoute(app.page, "#/library");
      await app.page.getByRole("button", { name: "Cancel job" }).click();
      await app.page.getByText("Cancelled", { exact: true }).waitFor();
      assert.deepEqual(calls(app, "media.job.cancel").map((c) => c.params), [{ id: JOB }]);
    });
  });

  test("jobs are reloaded with media.job.list after the event stream reconnects", async () => {
    await withApp({}, async (app) => {
      let job = running(0.3);
      serve(app, (rpc) => {
        rpc.handle("media.job.list", () => ({ jobs: [job] }), { write: false });
        rpc.handle("media.job.get", () => job, { write: false });
      });
      app.server.events.enable();
      await openRoute(app.page, "#/library");
      await app.server.events.waitForConnections(1);
      await app.page.getByText("1 jobs running").waitFor();
      const before = calls(app, "media.job.list").length;
      job = running(1, "failed");
      (job as any).error = "content_policy";
      app.server.events.dropConnections();
      await app.server.events.waitForConnections(2);
      await app.page.getByText("Jobs reloaded after reconnecting.").waitFor();
      assert.ok(calls(app, "media.job.list").length > before);
      const alert = app.page.getByRole("region", { name: "Jobs" }).getByRole("alert");
      await alert.getByText("refused this content").waitFor();
      assert.match((await alert.textContent()) ?? "", /content_policy/);
      await expectAxeClean(app.page, "job bar with a failed job");
    });
  });

  test("a job list that cannot be loaded is shown, not swallowed", async () => {
    await withApp({}, async (app) => {
      serve(app, (rpc) => rpc.handle("media.job.list", () => { throw rpcError("E_STORAGE", "boom"); }, { write: false }));
      await openRoute(app.page, "#/library");
      const alert = app.page.getByRole("region", { name: "Jobs" }).getByRole("alert");
      await alert.waitFor();
      assert.match((await alert.textContent()) ?? "", /E_STORAGE/);
    });
  });
});

describe("Library: defaults", opts, () => {
  test("the metadata switch is media.preferences.set, the default adapter is remembered per browser", async () => {
    await withApp({}, async (app) => {
      serve(app, (rpc) => rpc.handle("media.preferences.set", (p: any) => ({ global: p.embedMetadata, agents: {} }), { write: true }));
      await openRoute(app.page, "#/library");
      await app.page.getByText("Defaults", { exact: true }).click();
      await app.page.getByLabel("Embed the prompt in generated files").check();
      await app.page.getByText("Defaults saved.").waitFor();
      assert.deepEqual(calls(app, "media.preferences.set").map((c) => c.params), [{ embedMetadata: true }]);

      await app.page.getByLabel("Default adapter for Image").selectOption("box");
      await app.page.getByRole("button", { name: "Generate", exact: true }).click();
      assert.equal(await app.page.getByRole("dialog").getByLabel("Adapter and model").inputValue(), "box");
      await app.page.keyboard.press("Escape");
      await app.page.getByText("Defaults", { exact: true }).click();
      await expectAxeClean(app.page, "library with open defaults");
    });
  });

  test("German texts are used with a German locale", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      serve(app);
      await openRoute(app.page, "#/library", "de");
      await app.page.getByRole("button", { name: "Generieren", exact: true }).click();
      await app.page.getByRole("dialog").getByLabel("Anzahl der Bilder").waitFor();
    });
  });
});
