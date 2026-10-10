import test from "node:test";
import assert from "node:assert/strict";
import {withShell} from "./browser-harness.ts";
test("update settings, safe notes and dialog pass accessibility; failures keep the offer reviewable",async()=>{
 await withShell(async page=>{
  await page.evaluate(()=>(window as any).testShell.showUpdates());
  await page.getByRole("checkbox",{name:"Automatic patch updates"}).waitFor();
  assert(await page.getByRole("checkbox",{name:"Automatic patch updates"}).isChecked());
  await page.getByRole("checkbox",{name:"Automatic patch updates"}).uncheck();
  assert(!(await page.getByRole("checkbox",{name:"Automatic patch updates"}).isChecked()));
  await page.getByRole("button",{name:"View 0.1.1"}).click();
  assert.equal(await page.locator("dialog script, dialog a").count(),0);
  await page.getByRole("button",{name:"Update now"}).click();
  await page.getByRole("alert").getByText("Update could not be installed.").waitFor();
  assert(await page.getByRole("dialog").isVisible());
  await page.getByRole("button",{name:"DE",exact:true}).click();
  await page.getByText("Behoben",{exact:true}).waitFor();
  await page.addScriptTag({url:"/axe.js"});
  const violations=await page.evaluate(async()=>{const result=await(window as any).axe.run(document.querySelector("dialog"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});return result.violations.map((v:any)=>v.id);});assert.deepEqual(violations,[]);
  await page.getByRole("button",{name:"Later",exact:true}).click();await page.locator("dialog").waitFor({state:"detached"});assert.equal(await page.locator("dialog").count(),0);
 });
});
test("Store offer has notes and a fixed native Store action",async()=>{await withShell(async page=>{await page.evaluate(()=>(window as any).testShell.showUpdates(true));await page.getByRole("button",{name:"View 0.1.1"}).click();assert.equal(await page.getByRole("button",{name:"Update now"}).count(),0);await page.getByRole("button",{name:"Open Microsoft Store"}).click();await page.getByRole("button",{name:"Close",exact:true}).click();});});
