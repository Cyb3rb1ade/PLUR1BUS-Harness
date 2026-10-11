import {element,append,restoreFocus} from "../components/dom.ts";
import {button} from "../components/button.ts";
import {translate,type MessageKey} from "../i18n.ts";
import type {DesktopTransport} from "../ipc.ts";
import {upgradeProgress,type UpgradeOutcome} from "./upgrade-progress.ts";
export type UpgradeStatus={appVersion:string;installedVersion:string|null;imageDigest:string|null;rollbackAvailable:boolean;journal:null|{from:string;to:string;step:string;diagnostic:string|null;failedStep:string|null;snapshot:null|{createdAt:string;bytes:number;fileCount:number}}};
export function versionPage(transport:DesktopTransport,changed:()=>void){
 let status:UpgradeStatus|null=null,loaded=false,busy=false,failed=false,outcome:UpgradeOutcome|null=null,step:string|null=null;
 const t=(key:MessageKey,values?:Record<string,string>)=>translate(document.documentElement.lang==="de"?"de":"en",key,values);
 const load=async()=>{try{status=await transport.harnessUpgradeStatus!();}catch{failed=true;}changed();};
 if(transport.upgradeProgress)void transport.upgradeProgress(s=>{step=s;if(!["done","rolledBack","recoveryFailed"].includes(s))outcome=null;changed();}).catch(()=>{});
 if(transport.upgradeOutcome)void transport.upgradeOutcome(o=>{outcome=o;step=o.state;void load();}).catch(()=>{});
 function confirm(){
  if(!status?.rollbackAvailable||!status.journal)return;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const dialog=element("dialog","app-dialog"),title=element("h2",undefined,t("upgrade.restore"));
  title.id="rollback-title";dialog.setAttribute("aria-labelledby",title.id);
  append(dialog,title,element("p",undefined,t("upgrade.loss",{date:status.journal.snapshot?.createdAt??t("upgrade.backupDate")})));
  const cancel=button(t("upgrade.cancel"),()=>dialog.close());
  const restore=button(t("upgrade.restore"),()=>{
   dialog.close();busy=true;failed=false;outcome=null;step="rollingBack";changed();
   void transport.harnessRollback!(true).then(o=>{outcome=o;step=o?.state??null;}).catch(()=>{failed=true;}).finally(()=>{busy=false;void load();});
  },"primary");
  append(dialog,cancel,restore);document.body.append(dialog);
  dialog.addEventListener("close",()=>{dialog.remove();restoreFocus(opener);},{once:true});dialog.showModal();cancel.focus();
 }
 return ()=>{
  const root=element("section","version-page settings-stack");root.append(element("h2",undefined,t("upgrade.version")));
  if(!transport.harnessUpgradeStatus)return root;
  if(!loaded){loaded=true;void load();}
  if(status){
   const list=element("dl");
   for(const [name,value] of [[t("upgrade.app"),status.appVersion],[t("upgrade.harness"),status.installedVersion??t("upgrade.attached")],[t("upgrade.digest"),status.imageDigest??"—"]])append(list,element("dt",undefined,name),element("dd",undefined,value));
   root.append(list);
   const snap=status.journal?.snapshot;
   if(snap)root.append(element("p",undefined,t("upgrade.backup",{date:snap.createdAt,bytes:String(snap.bytes),files:String(snap.fileCount)})));
   if(status.rollbackAvailable){const back=button(t("upgrade.back",{from:status.journal!.from}),confirm);back.dataset.focusKey="rollback";back.disabled=busy;root.append(back);}
   const j=status.journal;
   if(!outcome&&(!step||["done","rolledBack","recoveryFailed","upgraded"].includes(step))&&j?.step==="rolledBack")outcome={state:"rolledBack",from:j.from,to:j.to,failed_step:j.failedStep??"rollingBack"};
   if(!outcome&&(!step||["done","rolledBack","recoveryFailed","upgraded"].includes(step))&&j?.step==="recoveryFailed")outcome={state:"recoveryFailed",diagnostic:j.diagnostic??""};
   if(!outcome&&(!step||["done","rolledBack","recoveryFailed","upgraded"].includes(step))&&j?.step==="done")outcome={state:"upgraded",to:j.to};
   if(step||j)root.append(upgradeProgress(step??j!.step,outcome,j?.diagnostic??undefined));
  }
  if(failed){const error=element("p",undefined,t("upgrade.operationFailed"));error.setAttribute("role","alert");root.append(error);}
  return root;
 };
}
