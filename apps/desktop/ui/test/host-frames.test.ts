import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {cardFields} from "../src/views/approvals.ts";
test("approval_card_shows_targets_before_reason",()=>{const fields=cardFields({id:"request",capability:"fs.write",effect:"write",targets:["/p1t/report"],risk:"medium",reversible:true,grantOptions:["once"],actionHash:"digest",reason:"unverified"});assert(fields.indexOf("targets")<fields.indexOf("reason"));assert.equal(fields.at(-1),"reason");});
test("approval renderer uses text nodes and a debug-gated decision transport",async()=>{const source=await readFile(new URL("../src/views/approvals.ts",import.meta.url),"utf8");assert(!source.includes("innerHTML"));assert(source.includes("decideEnabled"));});

import {withShell} from "./browser-harness.ts";
test("native approval cards escape foreign text, put targets before unverified reason, and default to SPA",async()=>{
 await withShell(async page=>{
  await page.evaluate(()=>{(window as any).testShell.showApprovals([{id:"request",capability:"fs.write",effect:"write report",targets:["/p1t/report", "<img src=x onerror=alert(1)>"],risk:"medium",reversible:true,grantOptions:["once"],actionHash:"synthetic",reason:"unverified"}]);});
  const labels=await page.locator("dt").allTextContents();assert(labels.indexOf("Exact targets")<labels.indexOf("The agent’s reason (unverified)"));assert.equal(labels.at(-1),"The agent’s reason (unverified)");
  assert.equal(await page.locator("article img").count(),0);assert.equal(await page.getByRole("button",{name:"Approve",exact:true}).isDisabled(),true);
  await page.getByRole("button",{name:"Open in PLUR1BUS"}).click();assert.deepEqual(await page.evaluate(()=>(window as any).testShell.approvalActions),["open:request"]);
  await page.addScriptTag({url:"/axe.js"});const violations=await page.evaluate(async()=>{const result=await(window as any).axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});return result.violations.map((v:any)=>v.id);});assert.deepEqual(violations,[]);
 });
});
test("computer access is an empty permission frame with a memory-only lock banner in both languages",async()=>{
 await withShell(async page=>{for(const locale of ["en","de"] as const){await page.evaluate(async locale=>{await(window as any).testShell.setPreferences({locale});(window as any).testShell.navigate("settings","computer-access");},locale);
 await page.getByText(locale==="en"?"No feature needs a system permission yet":"Noch benötigt keine Funktion eine Systemberechtigung").waitFor();
 await page.getByText(locale==="en"?"Secrets stay locked. Install or unlock a Secret Service keyring to store the key safely.":"Secrets bleiben gesperrt. Installiere oder entsperre einen Secret-Service-Schlüsselbund, um den Schlüssel sicher zu speichern.").waitFor();
 assert.equal(await page.getByRole("button",{name:/Grant permission|Berechtigung anfordern/}).count(),0);
 }});
});
