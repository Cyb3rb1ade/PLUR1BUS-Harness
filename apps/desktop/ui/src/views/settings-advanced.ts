import { installError } from "../models/install-errors.ts";
import { element,append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import type { DesktopTransport } from "../ipc.ts";
import type { MessageKey } from "../i18n.ts";
import { uninstallView } from "./uninstall.ts";
/** Packaging may supply its owned desktop-shortcut controls in the returned slot. */
export function advancedSettings(transport:DesktopTransport,t:(key:MessageKey)=>string,refresh:()=>void,desktopControls?:()=>HTMLElement) {
 let sandboxed=false;
 void transport.appInfo().then(info=>{sandboxed=info.sandboxed===true;refresh();}).catch(()=>{});
 let uninstall=false,addPath=true,busy=false,message:"done"|ReturnType<typeof installError>|null=null;
 const renderUninstall=uninstallView(transport,t,refresh,()=>{uninstall=false;refresh();});
 async function action(fn:()=>Promise<unknown>){if(busy)return;busy=true;message=null;refresh();try{await fn();message="done";}catch(reason){message=installError(reason);}finally{busy=false;refresh();}}
 return function render():HTMLElement {
  if(uninstall)return renderUninstall();const body=element("section","settings-card advanced-settings");append(body,element("h2",undefined,t("settings.advancedTitle")),element("p",undefined,t("advanced.cli")));
  if(!sandboxed){
  const label=element("label","quit-choice"),input=document.createElement("input");input.type="checkbox";input.checked=addPath;input.disabled=busy;input.dataset.focusKey="shim-path";input.addEventListener("change",()=>{addPath=input.checked;});append(label,input,document.createTextNode(t("advanced.path")));body.append(label);
  for(const [key,fn] of [["advanced.install",()=>transport.cliShimInstall?.(addPath)??Promise.reject()],["advanced.remove",()=>transport.cliShimRemove?.()??Promise.reject()]] as const){const control=button(t(key),()=>void action(fn));control.disabled=busy;body.append(control);}
  body.append(element("p",undefined,t("advanced.collision")));}
  else body.append(element("p",undefined,t("advanced.sandboxed")));
  const diagnostics=button(t("advanced.diagnostics"),()=>void action(()=>transport.diagnosticsOpen?.()??Promise.reject()));diagnostics.disabled=busy;body.append(diagnostics);
  if(desktopControls)body.append(desktopControls());
  const slot=element("div");slot.dataset.desktopShortcutControls="";body.append(slot);
  if(message){const status=element("p",undefined,t(`advanced.${message}`));status.setAttribute("role",message!=="done"?"alert":"status");body.append(status);}
  body.append(button(t("uninstall.title"),()=>{uninstall=true;refresh();queueMicrotask(()=>document.querySelector<HTMLElement>(".uninstall h2")?.focus());}));return body;
 };
}
