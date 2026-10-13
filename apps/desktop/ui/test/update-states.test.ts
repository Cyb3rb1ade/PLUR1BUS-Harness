import test from "node:test";
import assert from "node:assert/strict";
import {withShell} from "./browser-harness.ts";
import {UPDATE_VERIFY_DOCS,isVerifyFailure} from "../src/models/update-model.ts";

test("only the shell's release-check error codes count as a failed verification",()=>{
 for(const code of ["update-signature","update-digest","update-manifest"]) assert.equal(isVerifyFailure(code),true,code);
 for(const other of ["update-network","update-schema","update-settings",new Error("update-signature"),undefined]) assert.equal(isVerifyFailure(other),false,String(other));
 assert.match(UPDATE_VERIFY_DOCS,/^https:\/\/.+\/docs\/desktop\.md#signed-desktop-update-metadata-wp10$/);
});

test("a version that needs an older one first says so, and its install stays blocked",async()=>{
 await withShell(async page=>{
  await page.evaluate(()=>(window as any).testShell.showUpdateStates({offer:{action:"needsIntermediate",version:"0.1.0"}}));
  await page.getByRole("status").filter({hasText:"Install 0.1.0 first."}).waitFor();
  await page.getByRole("button",{name:"View 0.1.1"}).click();
  assert.equal(await page.getByRole("button",{name:"Update now"}).isDisabled(),true);
  await page.getByRole("dialog").getByText("Install 0.1.0 first.").waitFor();
  await page.getByRole("button",{name:"Close",exact:true}).click();
 });
});

test("a failed signature check is said plainly, links to the documentation and offers no install anyway",async()=>{
 await withShell(async page=>{
  await page.evaluate(()=>(window as any).testShell.showUpdateStates({checkError:"update-signature"}));
  await page.getByRole("button",{name:"Check for updates"}).click();
  const notice=page.getByRole("alert").filter({hasText:"could not be verified"});
  await notice.waitFor();
  assert.match(await notice.getByRole("link",{name:"How update verification works"}).getAttribute("href")??"",/docs\/desktop\.md#signed-desktop-update-metadata-wp10$/);
  assert.equal(await page.getByRole("alert").filter({hasText:"Update check failed"}).count(),0,"the generic failure text is replaced, not added");
  await page.getByRole("button",{name:"View 0.1.1"}).click();
  assert.equal(await page.getByRole("button",{name:"Update now"}).isDisabled(),true,"no install after a failed verification");
  await page.getByRole("button",{name:"Close",exact:true}).click();
 });
});

test("an ordinary check failure keeps its own text and does not claim a verification failure",async()=>{
 await withShell(async page=>{
  await page.evaluate(()=>(window as any).testShell.showUpdateStates({checkError:"update-network"}));
  await page.getByRole("button",{name:"Check for updates"}).click();
  await page.getByRole("alert").getByText("Update check failed. Nothing was installed.").waitFor();
  assert.equal(await page.getByRole("alert").filter({hasText:"could not be verified"}).count(),0);
  await page.getByRole("button",{name:"View 0.1.1"}).click();
  assert.equal(await page.getByRole("button",{name:"Update now"}).isDisabled(),false,"a network failure does not block the install button");
  await page.getByRole("button",{name:"Close",exact:true}).click();
 });
});
