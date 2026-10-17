import test from "node:test";
import assert from "node:assert/strict";
import {withShell} from "./browser-harness.ts";
import { validUninstallConfirmation } from "../src/views/uninstall.ts";
test("everything requires exact typed state name",()=>{assert(validUninstallConfirmation("app_only",""));assert(!validUninstallConfirmation("everything",""));assert(!validUninstallConfirmation("everything"," plur1bus-state"));assert(validUninstallConfirmation("everything","plur1bus-state"));});
test("runtime licence is presented before download and explicit consent gates installer",async()=>{await withShell(async page=>{
 await page.evaluate(()=>(window as any).testShell.showInstall());
 const install=page.getByRole("button",{name:"Download, verify and open installer"});await install.waitFor();assert(await install.isDisabled());assert.deepEqual(await page.evaluate(()=>(window as any).testShell.installCalls),[]);
 await page.getByRole("radio",{name:"Docker Desktop",exact:true}).check();await page.getByText(/Free use has personal/).waitFor();await page.getByRole("checkbox",{name:"I have reviewed the runtime licence notice"}).check();await install.click();
 assert.deepEqual(await page.evaluate(()=>(window as any).testShell.installCalls),[["docker",true],["recheck"]]);
});});
test("Advanced defaults to keeping data and Everything has a typed accessible confirmation",async()=>{await withShell(async page=>{
 await page.evaluate(()=>(window as any).testShell.showAdvanced());
 assert(await page.getByRole("checkbox",{name:"Add CLI directory to my PATH"}).isChecked());
 await page.getByRole("button",{name:"Uninstall PLUR1BUS",exact:true}).click();assert(await page.getByRole("radio",{name:/App only/}).isChecked());
 await page.getByRole("radio",{name:"Everything, including your data"}).check();await page.getByRole("button",{name:"Review removal summary"}).click();
 const run=page.getByRole("button",{name:"Remove selected items"});assert(await run.isDisabled());
 const typed=page.getByRole("textbox",{name:"Type plur1bus-state to confirm permanent data removal"});await typed.fill("PLUR1BUS-STATE");assert(await run.isDisabled());await typed.fill("plur1bus-state");assert(!(await run.isDisabled()));
 await page.addScriptTag({url:"/axe.js"});const violations=await page.evaluate(async()=>{const result=await(window as any).axe.run(document.querySelector(".uninstall"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});return result.violations.map((v:any)=>v.id);});assert.deepEqual(violations,[]);
 await run.focus();await page.keyboard.press("Enter");await page.getByText("Cleanup completed. You can now remove the app.").waitFor();assert.deepEqual(await page.evaluate(()=>(window as any).testShell.installCalls),[["uninstall","everything","plur1bus-state"]]);
});});
test("runtime and uninstall have German copy and keyboard controls",async()=>{await withShell(async page=>{await page.evaluate(()=>(window as any).testShell.showInstall("mac","de"));await page.getByText(/Apple-container-Paket/).waitFor();const checkbox=page.getByRole("checkbox",{name:"Ich habe den Lizenzhinweis zur Runtime gelesen"});await checkbox.focus();await page.keyboard.press("Space");assert(!(await page.getByRole("button",{name:"Gebündelten Apple-Installer öffnen"}).isDisabled()));await page.evaluate(()=>(window as any).testShell.showAdvanced("de"));await page.getByRole("button",{name:"PLUR1BUS deinstallieren",exact:true}).click();assert(await page.getByRole("radio",{name:/Nur App/}).isChecked());});});

test("only known installer codes select copy; arbitrary errors never become diagnostics",async()=>{const {installError}=await import("../src/models/install-errors.ts");assert.equal(installError("shim-collision"),"collision");assert.equal(installError("installer-signature"),"signature");assert.equal(installError("Authorization: Bearer secret"),"failed");assert.equal(installError(new Error("secret")),"failed");});

test("shortcut keyboard control commits native state and preserves disabled state on failure",async()=>{await withShell(async page=>{
 await page.evaluate(()=>(window as any).testShell.showIntegration("desktop"));let toggle=page.getByRole("checkbox",{name:"Desktop icon"});await toggle.waitFor();await toggle.focus();await page.keyboard.press("Space");await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[data-focus-key="desktop-integration"]')?.checked===true);
 await page.evaluate(()=>(window as any).testShell.showIntegration("menu",true));toggle=page.getByRole("checkbox",{name:"AppImage menu integration"});await toggle.waitFor();await toggle.focus();await page.keyboard.press("Space");await page.getByRole("alert").waitFor();assert(!(await toggle.isChecked()));assert(!((await page.locator("body").innerText()).includes("foreign-secret")));
 await page.evaluate(()=>(window as any).testShell.showIntegration("store"));await page.getByText(/Windows manages Store startup/).waitFor();assert.equal(await page.getByRole("checkbox").count(),0);
});});
