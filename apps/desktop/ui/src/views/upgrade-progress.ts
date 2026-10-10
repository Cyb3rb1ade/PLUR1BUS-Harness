import {element,append} from "../components/dom.ts";
import {button} from "../components/button.ts";
import {translate,type MessageKey} from "../i18n.ts";
export type UpgradeOutcome={state:"upgraded";to:string}|{state:"rolledBack";failed_step:string;from:string;to:string}|{state:"recoveryFailed";diagnostic:string};
const steps=["app","preflight","stopping","snapshotting","swapping","migrating","gating","done","rollingBack","restoringSnapshot","startingPrevious","gatingPrevious","rolledBack","recoveryFailed"];
export function stepLabel(step:string,de:boolean):string{
 return translate(de?"de":"en",`upgrade.step.${steps.includes(step)?step:"fallback"}` as MessageKey);
}
export function upgradeProgress(step:string,outcome:UpgradeOutcome|null,diagnostic?:string):HTMLElement{
 const de=document.documentElement.lang==="de";
 const t=(key:MessageKey,values?:Record<string,string>)=>translate(de?"de":"en",key,values);
 const root=element("section","upgrade-progress");root.setAttribute("aria-live","polite");
 root.append(element("h2",undefined,stepLabel(step,de)));
 if(!outcome){
  root.append(element("p",undefined,t("upgrade.wait")));
  const list=element("ol","progress-list");
  for(const [index,item] of steps.slice(0,8).entries()){const row=element("li",`progress-item progress-${index<steps.indexOf(step)?"done":"waiting"}`);append(row,element("span","progress-dot"),element("span",undefined,stepLabel(item,de)));if(item===step)row.setAttribute("aria-current","step");list.append(row);}
  root.append(list);
 } else if(outcome.state==="upgraded")root.append(element("p",undefined,t("upgrade.success",{to:outcome.to})));
 else if(outcome.state==="rolledBack")root.append(element("p",undefined,t(outcome.failed_step==="done"?"upgrade.manualDone":"upgrade.rolled",{to:outcome.to,from:outcome.from,step:stepLabel(outcome.failed_step,de)})));
 else{
  const error=element("p",undefined,t("upgrade.recovery"));error.setAttribute("role","alert");root.append(error);
  root.append(element("p",undefined,t("upgrade.guide")));
 }
 const details=diagnostic??(outcome?.state==="recoveryFailed"?outcome.diagnostic:undefined);
 if(details){
  root.append(element("pre","diagnostic-details",details));
  const error=element("p");error.setAttribute("aria-live","polite");
  root.append(button(t("upgrade.copy"),()=>{void navigator.clipboard.writeText(details).catch(()=>{error.setAttribute("role","alert");error.textContent=t("upgrade.copyFailed");});}),error);
 }
 return root;
}
