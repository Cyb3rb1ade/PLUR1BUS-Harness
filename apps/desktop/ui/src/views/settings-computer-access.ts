import {element,append} from "../components/dom.ts";
import {button} from "../components/button.ts";
import type {MessageKey} from "../i18n.ts";
import type {DesktopTransport,BridgeSettings,HelperStatus} from "../ipc.ts";
export function computerAccess(transport:DesktopTransport,t:(key:MessageKey)=>string,changed:()=>void){
 let initialized=false;
 let helper:HelperStatus|null=null;let bridge:BridgeSettings|null=null;let failed=false;let busy=false;
 async function refresh(){try{helper=await transport.helperStatus?.()??null;bridge=await transport.bridgeSettings?.()??null;}catch{failed=true;}changed();}
 return (runtimeOnly=false)=>{
  if(!initialized){initialized=true;void refresh();}
  const page=element("section","settings-card");if(!runtimeOnly)append(page,element("h2",undefined,t("host.computerAccess")),element("p",undefined,t("host.empty")));
  page.append(element("p",undefined,t(helper?.ready?"host.ready":helper?.restarting?"host.restarting":"host.starting")));
  page.append(button(t("host.refresh"),()=>{void refresh();},"quiet"));
  if(bridge&&transport.bridgeSettings){const label=element("label","quit-choice");const toggle=document.createElement("input");toggle.type="checkbox";toggle.checked=bridge.enabled;toggle.disabled=busy;toggle.dataset.focusKey="host-key-unlock";
   toggle.addEventListener("change",()=>{busy=true;failed=false;changed();void transport.bridgeSettings!(toggle.checked).then(value=>{bridge=value;}).catch(()=>{failed=true;}).finally(()=>{busy=false;changed();});});append(label,toggle,document.createTextNode(t("host.unlock")));page.append(label);
   page.append(element("p",undefined,t((bridge.secretsState??(bridge.secretsLocked?"locked":"unknown"))==="locked"?"host.locked":bridge.secretsState==="unlocked"?"host.unlocked":"host.statusHint")));
   if(bridge.memoryOnly)page.append(element("p","banner",t("host.memoryOnly")));
  }
  if(failed){const error=element("p",undefined,t("host.failed"));error.setAttribute("role","alert");page.append(error);}
  return page;
 };
}
