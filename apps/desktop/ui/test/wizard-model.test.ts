import { test } from "node:test";
import assert from "node:assert/strict";
import { initialWizard, advanceWizard, agreeWizard, foundRuntimes, completeWizard, installerFor, errors, failWizard, retryWizard } from "../src/models/wizard-model.ts";
const runtime = { id: "synthetic", kind: "docker" as const, endpoint: "unix:///p1t/engine.sock", source: "podman", engine: "Podman", version: "5.0", state: "ready" as const };
test("wizard happy path is four primary actions and never asks offline or online", () => {
 let s=initialWizard();s=advanceWizard(s);assert.equal(s.step,"licences");assert.equal(advanceWizard(s).step,"licences");s=agreeWizard(s,true);s=advanceWizard(s);assert.equal(s.step,"runtime");s=foundRuntimes(s,[runtime],runtime.id);s=advanceWizard(s);assert.equal(s.step,"installing");s=completeWizard(s,"synthetic-connection",s.operation);assert.equal(s.step,"done");s=advanceWizard(s);assert.equal(s.step,"opened");assert.equal(s.actions,4);
 assert.ok(!Object.keys(s).includes("resources")&&!Object.keys(s).includes("mode"));
});
test("no runtime on macOS26 offers the Apple pkg; macOS15 shows the guide",()=>{assert.equal(installerFor("mac",26),"apple-pkg");assert.equal(installerFor("mac",15),"guide");assert.equal(installerFor("linux",null),"podman-socket");assert.equal(installerFor("windows",null),"vendor");});
test("each error kind maps to a message and a retry target",()=>{for(const kind of Object.keys(errors) as Array<keyof typeof errors>){const s=failWizard(initialWizard(),kind);assert.equal(s.step,"error");assert.equal(retryWizard(s).step,errors[kind].retry);assert.ok(errors[kind].message.startsWith("wizard.error."));}});
test("a stale completion after cancellation never opens the SPA",()=>{let s:import("../src/models/wizard-model.ts").Wizard={...initialWizard(),step:"installing",operation:1};s=failWizard(s,"cancelled");assert.equal(completeWizard(s,"stale-connection",1).connectionId,null);});
test("new runtime results retain the saved choice even when it is unavailable",()=>{const s={...initialWizard(),selected:"old-runtime"};assert.equal(foundRuntimes(s,[runtime],runtime.id).selected,"old-runtime");});
