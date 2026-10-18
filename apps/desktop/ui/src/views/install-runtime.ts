import { installError } from "../models/install-errors.ts";
import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import type { DesktopTransport, InstallOptions, Vendor } from "../ipc.ts";
import type { MessageKey } from "../i18n.ts";
export function installRuntime(transport:DesktopTransport,t:(key:MessageKey)=>string,refresh:()=>void,recheck:()=>void) {
 let options:InstallOptions|null=null,loading=false,agreed=false,busy=false,error:ReturnType<typeof installError>|false=false,done=false,vendor:Vendor="podman",phase="download";
 function load(){if(loading||options||!transport.installOptions)return;loading=true;void transport.installOptions().then(value=>options=value).catch(()=>error="failed").finally(()=>{loading=false;refresh();});}
 async function run(action:()=>Promise<void>){if(busy||!agreed)return;busy=true;error=false;done=false;refresh();let unlisten:(()=>void)|undefined;try{unlisten=await transport.runtimeInstallProgress?.(step=>{if(["download","check","installer","recheck"].includes(step)){phase=step;refresh();}});await action();done=true;recheck();}catch(reason){error=installError(reason);}finally{unlisten?.();busy=false;refresh();}}
 return function render():HTMLElement {
  load();const body=element("section","settings-card install-runtime");append(body,element("h2",undefined,t("installRuntime.title")),element("p",undefined,t("installRuntime.guide")));
  if(!options){const status=element("p",undefined,t(error?`installRuntime.${error}`:"installRuntime.loading"));status.setAttribute("role",error?"alert":"status");body.append(status);return body;}
  if(options.platform==="linux"){
   body.append(element("p",undefined,t("installRuntime.linux")));
   const enable=button(t("installRuntime.podmanSocket"),()=>{agreed=true;void run(()=>transport.runtimeEnablePodmanSocket?.()??Promise.reject());});enable.disabled=busy;body.append(enable);
  } else if(options.platform==="mac"&&!options.appleAvailable) body.append(element("p",undefined,t("installRuntime.macGuide")));
  else {
   if(options.platform==="win"){
    const group=element("fieldset");group.append(element("legend",undefined,t("installRuntime.vendor")));
    for(const choice of ["podman","docker"] as const){const label=element("label","quit-choice"),radio=document.createElement("input");radio.type="radio";radio.name="runtime-vendor";radio.checked=vendor===choice;radio.disabled=busy;radio.dataset.focusKey=`vendor-${choice}`;radio.addEventListener("change",()=>{vendor=choice;agreed=false;refresh();});append(label,radio,document.createTextNode(choice==="docker"?"Docker Desktop":"Podman Desktop"));group.append(label);}body.append(group);
    body.append(element("p",undefined,t(vendor==="docker"?"installRuntime.dockerLicence":"installRuntime.podmanLicence")));
   }else body.append(element("p",undefined,t("installRuntime.appleLicence")));
   const label=element("label","quit-choice"),accept=document.createElement("input");accept.type="checkbox";accept.checked=agreed;accept.disabled=busy;accept.dataset.focusKey="runtime-licence";accept.addEventListener("change",()=>{agreed=accept.checked;refresh();});append(label,accept,document.createTextNode(t("installRuntime.accept")));body.append(label);
   const install=button(t(options.platform==="mac"?"installRuntime.appleInstall":"installRuntime.vendorInstall"),()=>void run(()=>options?.platform==="mac"?(transport.runtimeInstallApple?.(agreed)??Promise.reject()):(transport.runtimeInstallVendor?.(vendor,agreed)??Promise.reject())),"primary");install.disabled=!agreed||busy;body.append(install);
  }
  if(options.platform==="win"&&(busy||done)){const steps=element("ol");for(const step of ["download","check","installer","recheck"]){const row=element("li",undefined,t(`installRuntime.step.${step}` as MessageKey));if(step===phase)row.setAttribute("aria-current","step");steps.append(row);}body.append(steps);}
  if(busy||done){const status=element("p",undefined,t(busy?"installRuntime.working":"installRuntime.done"));status.setAttribute("role","status");body.append(status);}
  if(error){const alert=element("p",undefined,t(`installRuntime.${error}`));alert.setAttribute("role","alert");body.append(alert);}
  return body;
 };
}
