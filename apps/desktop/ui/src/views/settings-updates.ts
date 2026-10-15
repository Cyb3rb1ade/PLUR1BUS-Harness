import {element,append,restoreFocus,trapDialogFocus} from "../components/dom.ts";
import {button} from "../components/button.ts";
import {isVerifyFailure,notesBlocks,UPDATE_VERIFY_DOCS,type UpdatePreferences,type UpdateSnapshot} from "../models/update-model.ts";
import {translate,type MessageKey} from "../i18n.ts";
import type {DesktopTransport} from "../ipc.ts";
/** Shell updates keep all release verification and installation inputs in Rust. */
export function updatesPage(transport:DesktopTransport,changed:()=>void){
 let snapshot:UpdateSnapshot|null=null;let busy=false;let failed=false;let verifyFailed=false;let loaded=false;
 const de=()=>document.documentElement.lang==="de";
 const t=(key:MessageKey,values?:Record<string,string>)=>translate(de()?"de":"en",key,values);
 // A release that did not pass its signature, digest or manifest check: said plainly, never offered for install anyway.
 const verifyNotice=()=>{const box=element("div","banner");box.setAttribute("role","alert");const link=element("a",undefined,t("update.verify.docs"));link.href=UPDATE_VERIFY_DOCS;link.target="_blank";link.rel="noopener noreferrer";append(box,element("p",undefined,t("update.verify.failed")),element("p",undefined,t("update.verify.body")),link);return box;};
 const intermediateNotice=(version:string)=>{const box=element("div","banner");box.setAttribute("role","status");append(box,element("p",undefined,t("update.intermediate",{version})),element("p",undefined,t("update.intermediateHint",{version})));return box;};
 async function operation(task:()=>Promise<UpdateSnapshot>){if(busy)return;busy=true;failed=false;verifyFailed=false;changed();try{snapshot=await task();}catch(error){failed=true;verifyFailed=isVerifyFailure(error);}finally{busy=false;changed();}}
 async function save(patch:Partial<UpdatePreferences>){if(snapshot&&transport.updateSettings)await operation(()=>transport.updateSettings!({...snapshot!.settings,...patch}));}
 function offer(){if(!snapshot?.release)return;const r=snapshot.release;const kinds:Record<string,MessageKey>={patch:"update.kind.patch",minor:"update.kind.minor",major:"update.kind.major"};const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;const dialog=element("dialog","app-dialog");const title=element("h2",undefined,t("update.title"));title.id="update-dialog-title";dialog.setAttribute("aria-labelledby",title.id);
 append(dialog,title,element("p",undefined,`${r.version} · ${t(kinds[r.kind]??"update.kind.other")} · ${t(r.channel==="stable"?"update.stable":"update.beta")} · ${r.date}`));
 if(r.security)dialog.append(element("p","banner",t("update.security")));
 const body=element("div","update-notes");const notes=(locale:"de"|"en")=>{body.replaceChildren();for(const source of [r.notes[locale],r.migrationNote?.[locale]??""]){let list:HTMLElement|null=null;for(const block of notesBlocks(source)){if(block.kind==="list"){if(!list){list=element("ul");body.append(list);}list.append(element("li",undefined,block.text));}else{list=null;body.append(element("p",undefined,block.text));}}}};
 const languageButtons=(["de","en"] as const).map(locale=>{
  const control=button(t(locale==="de"?"update.notesDe":"update.notesEn"),()=>{
   notes(locale);for(const item of languageButtons)item.control.setAttribute("aria-pressed",String(item.locale===locale));
  });
  control.setAttribute("aria-label",t(locale==="de"?"settings.german":"settings.english"));
  control.setAttribute("aria-pressed",String(locale===(de()?"de":"en")));
  return {locale,control};
 });
 append(dialog,...languageButtons.map(item=>item.control),body);notes(de()?"de":"en");
 const footer=element("div","dialog-footer");const close=()=>dialog.close();
 append(footer,button(t("update.hold"),()=>{close();void save({held:true});},"quiet"),button(t("update.skip"),()=>{close();void operation(()=>transport.updateSkip!());}),button(t("update.later"),()=>{close();void operation(()=>transport.updateLater!());}));
 if(snapshot.storeBuild){append(dialog,element("p",undefined,t("update.storeManaged")));footer.append(button(t("update.storeOpen"),()=>{void transport.updateStoreOpen?.().catch(()=>{failed=true;changed();});}));}
 else {const install=button(t("update.install"),()=>{install.disabled=true;void transport.updateInstall!().catch((reason:unknown)=>{failed=true;verifyFailed=isVerifyFailure(reason);install.disabled=verifyFailed;if(verifyFailed){dialog.append(verifyNotice());return;}const error=element("p",undefined,t("update.installFailed"));error.setAttribute("role","alert");dialog.append(error);});},"primary");install.disabled=!snapshot.installAvailable||snapshot.offer.action==="needsIntermediate"||verifyFailed;footer.append(install);if(!snapshot.installAvailable)dialog.append(element("p",undefined,t("update.channelManaged")));}
 if(snapshot.offer.action==="needsIntermediate")dialog.append(element("p",undefined,t("update.intermediate",{version:snapshot.offer.version??""})));
 footer.append(button(t("update.close"),close));dialog.append(footer);document.body.append(dialog);dialog.addEventListener("close",()=>{dialog.remove();restoreFocus(opener);},{once:true});trapDialogFocus(dialog);dialog.showModal();footer.querySelector<HTMLButtonElement>("button")?.focus();
 }
 return ()=>{const root=element("section","settings-stack");if(!transport.updateSettings||!transport.updateCheck)return root;
 if(!loaded){loaded=true;void operation(()=>transport.updateSettings!());}
 const s=snapshot?.settings;
 if(s){const label=element("label");const select=element("select");select.setAttribute("aria-label",t("update.channelLabel"));for(const channel of ["stable","beta"] as const){const option=element("option",undefined,t(channel==="stable"?"update.stable":"update.beta"));option.value=channel;select.append(option);}select.value=s.channel;select.dataset.focusKey="update-channel";select.disabled=busy;select.addEventListener("change",()=>void save({channel:select.value as "stable"|"beta"}));append(label,document.createTextNode(t("update.channel")),select);root.append(label);
 for(const [field,key] of [["autoPatch","update.autoPatch"],["held","update.hold"],["checkOnStart","update.checkOnStart"]] as const){const label=element("label","quit-choice");const input=element("input");input.type="checkbox";input.dataset.focusKey=`update-${field}`;input.checked=s[field];input.disabled=busy;input.addEventListener("change",()=>void save({[field]:input.checked}));append(label,input,document.createTextNode(t(key)));root.append(label);}
 const quiet=element("fieldset");quiet.append(element("legend",undefined,t("update.quiet")));for(const index of [0,1] as const){const label=element("label");const input=element("input");input.type="number";input.min="0";input.max="23";input.dataset.focusKey=`update-hour-${index}`;input.value=String(s.quietHours[index]);input.disabled=busy;input.addEventListener("change",()=>{const value=Number(input.value);if(input.value.trim()===""||!Number.isInteger(value)||value<0||value>23){input.value=String(s.quietHours[index]);return;}const hours:[number,number]=[...s.quietHours];hours[index]=value;void save({quietHours:hours});});append(label,document.createTextNode(t(index===0?"update.from":"update.to")),input);quiet.append(label);}root.append(quiet);
 }
 root.append(element("p",undefined,t("update.policy")));
 if(snapshot?.offer.action==="needsIntermediate")root.append(intermediateNotice(snapshot.offer.version??""));
 if(verifyFailed)root.append(verifyNotice());
 const check=button(t("update.check"),()=>void operation(()=>transport.updateCheck!()),"primary");check.disabled=busy;root.append(check);
 if(snapshot?.release&&snapshot.offer.action!=="none")root.append(button(t("update.view",{version:snapshot.release.version}),offer));
 if(failed&&!verifyFailed){const error=element("p",undefined,t("update.failed"));error.setAttribute("role","alert");root.append(error);}
 return root;};
}
