/** Import re-embedding reuses actual model licence confirmations; a selector is never a fabricated receipt. */
import assert from "node:assert/strict";
import test from "node:test";
import { confirmImportLicence } from "../src/pages/import/licence.ts";
import { MODEL_CHOICES } from "../src/pages/setup/licences.ts";

test("explicit import licence confirmation uses the existing human method and actual response selector", async () => {
  const model = MODEL_CHOICES.find((choice) => choice.kind === "embedding" && choice.nc)!;
  const calls: unknown[] = [];
  const result = await confirmImportLicence(
    {
      rpc: async (method, params) => {
        calls.push({ method, params });
        return {
          acceptance: {
            who: "alice",
            at: new Date().toISOString(),
            licence: model.licence,
            model: model.model,
            revision: model.revision,
            source: "memory",
          },
        };
      },
    },
    model.model,
    "alice",
  );
  assert.equal(result, model.licence);
  assert.deepEqual(calls, [{ method: "model.licence.confirm", params: { model: model.model, accepted: true } }]);
});
test("unexpected actor, model revision or licence cannot become an import acceptance selector", async () => {
  const model = MODEL_CHOICES.find((choice) => choice.kind === "embedding" && choice.nc)!;
  for (const override of [{ who: "foreign" }, { revision: "unreviewed" }, { licence: "invented" }]) {
    await assert.rejects(
      confirmImportLicence(
        {
          rpc: async () => ({
            acceptance: {
              who: "alice",
              at: new Date().toISOString(),
              licence: model.licence,
              model: model.model,
              revision: model.revision,
              source: "memory",
              ...override,
            },
          }),
        },
        model.model,
        "alice",
      ),
    );
  }
});

test("a source candidate cannot record a different pinned revision and scope denial stays an authority failure", async () => {
  const { licenceAuthorityDenied } = await import("../src/pages/import/licence.ts");
  const model = MODEL_CHOICES.find((choice) => choice.kind === "embedding" && choice.nc)!;
  let called = false;
  await assert.rejects(
    confirmImportLicence(
      {
        rpc: async () => {
          called = true;
          return {};
        },
      },
      model.model,
      "alice",
      "unreviewed-revision",
    ),
  );
  assert.equal(called, false, "the human did not approve another canonical model revision");
  assert.equal(licenceAuthorityDenied({ kind: "forbidden" }), true);
  assert.equal(licenceAuthorityDenied({ kind: "rpc-error", errorCode: "E_DENIED" }), true);
  assert.equal(licenceAuthorityDenied({ kind: "rpc-error", errorCode: "E_CORE_UNAVAILABLE" }), false);
  assert.equal(licenceAuthorityDenied(new Error("denied")), false);
});

test("NC policy review reads real separate use-class and global acknowledgement without writing settings", async () => {
  const { readImportLicencePolicy } = await import("../src/pages/import/licence.ts");
  const calls: unknown[] = [];
  assert.deepEqual(
    await readImportLicencePolicy({
      rpc: async (...args) => {
        calls.push(args);
        return { value: args[1].key === "embedding.useClass" ? "research" : false };
      },
    }),
    { authorityDenied: false, useClass: "research", acceptedNcLicence: false },
  );
  assert.deepEqual(calls, [
    ["config.get", { key: "embedding.useClass" }, { write: false }],
    ["config.get", { key: "embedding.acceptedNcLicence" }, { write: false }],
  ]);
  assert.deepEqual(
    await readImportLicencePolicy({
      rpc: async () => {
        throw { kind: "rpc-error", errorCode: "E_DENIED" };
      },
    }),
    { authorityDenied: true },
  );
  await assert.rejects(
    readImportLicencePolicy({
      rpc: async () => {
        throw { kind: "rpc-error", errorCode: "E_CORE_UNAVAILABLE" };
      },
    }),
  );
});
