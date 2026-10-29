import test from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("native approval controls show code and purpose, open through Rust, and retain an accessible retry", async () => {
  await withShell(async page => {
    await page.evaluate(async () => (window as any).testShell.setConnections([{id:"one",name:"MFA desktop",kind:"remote",
      origin:"https://harness.example",installationId:"one",deviceId:"one",tokenHint:"hint",pairingNeeded:false}]));
    await page.getByRole("button",{name:"View connections",exact:true}).click();
    await page.getByLabel("Approve existing enrolled access for").selectOption("imports");
    await page.getByRole("button",{name:"Start browser approval",exact:true}).click();
    await page.getByText("ABCD-2345",{exact:true}).waitFor();
    await page.getByText("https://harness.example/#/desktop/approve",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Open verification page",exact:true}).click();
    await page.getByRole("button",{name:"Check approval",exact:true}).click();
    await page.getByText("Approved. Retry the action or reopen this connection to continue.",{exact:true}).waitFor();
    const calls = await page.evaluate(() => (window as any).testShell.calls.stepUps);
    assert.deepEqual(calls.map((call: {action:string})=>call.action),["begin","open","poll"]);
    assert.deepEqual(Object.keys(calls[0]).sort(),["action","connectionId","purpose"]);
    assert.deepEqual(Object.keys(calls[1]).sort(),["action","connectionId","handle"]);
    assert.equal(JSON.stringify(calls).includes("proofToken"),false);
    await page.addScriptTag({url:"/axe.js"});
    await page.setViewportSize({width:400,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(await page.evaluate(async ()=>(await (window as any).axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map((value:{id:string})=>value.id)),[]);
    await page.getByRole("button",{name:"Cancel approval",exact:true}).click();
    await page.getByRole("button",{name:"Start browser approval",exact:true}).waitFor();
  },undefined,{stepUp:true});
});
