import { element,append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import type { DesktopTransport,UninstallLevel,UninstallSummary } from "../ipc.ts";
import type { MessageKey } from "../i18n.ts";
export function validUninstallConfirmation(level:UninstallLevel,value:string):boolean{return level!=="everything"||value==="plur1bus-state";}
export function uninstallView(transport:DesktopTransport,t:(key:MessageKey,values?:Record<string,string>)=>string,refresh:()=>void,close:()=>void) {
 let stage:"choice"|"summary"|"progress"="choice",level:UninstallLevel="app_only",summary:UninstallSummary|null=null,typed="",busy=false,error=false,complete=false;const steps:string[]=[];
 const focus=()=>queueMicrotask(()=>document.querySelector<HTMLElement>(".uninstall h2")?.focus());
 async function review(){if(busy)return;busy=true;error=false;refresh();try{summary=await transport.uninstallSummary?.(level)??null;if(!summary)throw Error();stage="summary";typed="";}catch{error=true;}finally{busy=false;refresh();focus();}}
 async function execute(){if(busy||!validUninstallConfirmation(level,typed))return;busy=true;error=false;stage="progress";steps.length=0;refresh();focus();let unlisten:(()=>void)|undefined;
  try{unlisten=await transport.uninstallProgress?.(step=>{if(["container","network","images","volumes","keychain","shim","complete"].includes(step)){steps.push(step);refresh();}});if(!transport.uninstallRun)throw Error();await transport.uninstallRun(level,typed);complete=true;}catch{error=true;}finally{busy=false;unlisten?.();refresh();focus();}
 }
 return function render():HTMLElement {
  const body=element("section","settings-card uninstall"),heading=element("h2",undefined,t("uninstall.title"));heading.tabIndex=-1;body.append(heading);
  if(stage==="choice"){
   const group=element("fieldset");group.append(element("legend",undefined,t("uninstall.choose")));
   for(const value of ["app_only","app_and_images","everything"] as const){const label=element("label","quit-choice"),radio=document.createElement("input");radio.type="radio";radio.name="uninstall-level";radio.checked=level===value;radio.disabled=busy;radio.dataset.focusKey=`uninstall-${value}`;radio.addEventListener("change",()=>{level=value;});append(label,radio,document.createTextNode(t(`uninstall.${value}`)));group.append(label);}append(body,group,element("p",undefined,t("uninstall.keepsDefault")));const next=button(t("uninstall.review"),()=>void review());next.disabled=busy;body.append(next);
  }
  if(stage==="summary"&&summary){
   append(body,element("p",undefined,t(summary.preservesData?"uninstall.keepsData":"uninstall.removesData")),element("p",undefined,t("uninstall.appRemoval")));
   const list=element("ul");for(const name of summary.containers)list.append(element("li",undefined,t("uninstall.container",{name})));for(const name of summary.images)list.append(element("li",undefined,t("uninstall.image",{name})));for(const volume of summary.volumes)list.append(element("li",undefined,t("uninstall.volume",{name:volume.name,size:volume.bytes===null?t("uninstall.unknownSize"):`${volume.bytes} B` })));list.append(element("li",undefined,t("uninstall.shim")));if(summary.removesKeychain)list.append(element("li",undefined,t("uninstall.keychain")));body.append(list);
   const run=button(t("uninstall.run"),()=>void execute(),"primary");run.disabled=!validUninstallConfirmation(level,typed)||busy;
   if(level==="everything"){const label=element("label");label.htmlFor="uninstall-confirmation";label.textContent=t("uninstall.type");const input=document.createElement("input");input.id="uninstall-confirmation";input.value=typed;input.autocomplete="off";input.spellcheck=false;input.setAttribute("aria-describedby","uninstall-warning");input.addEventListener("input",()=>{typed=input.value;run.disabled=!validUninstallConfirmation(level,typed)||busy;});const warning=element("p",undefined,t("uninstall.removesData"));warning.id="uninstall-warning";append(body,warning,label,input);}
   append(body,button(t("uninstall.back"),()=>{stage="choice";typed="";refresh();focus();}),run);
  }
  if(stage==="progress"){const list=element("ol");list.setAttribute("aria-live","polite");for(const step of steps)list.append(element("li",undefined,t(`uninstall.step.${step}` as MessageKey)));body.append(list);if(busy){const status=element("p",undefined,t("uninstall.working"));status.setAttribute("role","status");body.append(status);}if(complete)body.append(element("p",undefined,t("uninstall.complete")));}
  if(error){const alert=element("p",undefined,t("uninstall.failed"));alert.setAttribute("role","alert");body.append(alert);}
  const cancel=button(t("panel.close"),close);cancel.disabled=busy;body.append(cancel);return body;
 };
}
