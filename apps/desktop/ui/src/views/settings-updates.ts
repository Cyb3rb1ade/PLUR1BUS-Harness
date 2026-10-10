import {element,append,restoreFocus} from "../components/dom.ts";
import {button} from "../components/button.ts";
import {notesBlocks,type UpdatePreferences,type UpdateSnapshot} from "../models/update-model.ts";
import type {DesktopTransport} from "../ipc.ts";
/** Shell updates keep all release verification and installation inputs in Rust. */
export function updatesPage(transport:DesktopTransport,changed:()=>void){
 let snapshot:UpdateSnapshot|null=null;let busy=false;let failed=false;let loaded=false;
 const de=()=>document.documentElement.lang==="de";
 const copy=(en:string,german:string)=>de()?german:en;
 async function operation(task:()=>Promise<UpdateSnapshot>){if(busy)return;busy=true;failed=false;changed();try{snapshot=await task();}catch{failed=true;}finally{busy=false;changed();}}
 async function save(patch:Partial<UpdatePreferences>){if(snapshot&&transport.updateSettings)await operation(()=>transport.updateSettings!({...snapshot!.settings,...patch}));}
 function offer(){if(!snapshot?.release)return;const r=snapshot.release;const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;const dialog=element("dialog","app-dialog");const title=element("h2",undefined,copy("Update PLUR1BUS","PLUR1BUS aktualisieren"));title.id="update-dialog-title";dialog.setAttribute("aria-labelledby",title.id);
 append(dialog,title,element("p",undefined,`${r.version} · ${r.kind} · ${r.channel} · ${r.date}`));
 if(r.security)dialog.append(element("p","banner",copy("Security update · offered again after seven days","Sicherheitsupdate · wird nach sieben Tagen erneut angeboten")));
 const body=element("div","update-notes");const notes=(locale:"de"|"en")=>{body.replaceChildren();for(const source of [r.notes[locale],r.migrationNote?.[locale]??""]){let list:HTMLElement|null=null;for(const block of notesBlocks(source)){if(block.kind==="list"){if(!list){list=element("ul");body.append(list);}list.append(element("li",undefined,block.text));}else{list=null;body.append(element("p",undefined,block.text));}}}};
 append(dialog,button("DE",()=>notes("de")),button("EN",()=>notes("en")),body);notes(de()?"de":"en");
 const footer=element("div","dialog-footer");const close=()=>dialog.close();
 append(footer,button(copy("Hold this version","Version halten"),()=>{close();void save({held:true});},"quiet"),button(copy("Skip this version","Version überspringen"),()=>{close();void operation(()=>transport.updateSkip!());}),button(copy("Later","Später"),()=>{close();void operation(()=>transport.updateLater!());}));
 if(snapshot.storeBuild){append(dialog,element("p",undefined,copy("Updates are managed by Microsoft Store.","Updates werden vom Microsoft Store verwaltet.")));footer.append(button(copy("Open Microsoft Store","Microsoft Store öffnen"),()=>{void transport.updateStoreOpen?.().catch(()=>{failed=true;changed();});}));}
 else {const install=button(copy("Update now","Jetzt aktualisieren"),()=>{install.disabled=true;void transport.updateInstall!().catch(()=>{failed=true;install.disabled=false;const error=element("p",undefined,copy("Update could not be installed.","Update konnte nicht installiert werden."));error.setAttribute("role","alert");dialog.append(error);});},"primary");install.disabled=!snapshot.installAvailable||snapshot.offer.action==="needsIntermediate";footer.append(install);if(!snapshot.installAvailable)dialog.append(element("p",undefined,copy("Updates are managed by your installation channel.","Updates werden durch deinen Installationskanal verwaltet.")));}
 if(snapshot.offer.action==="needsIntermediate")dialog.append(element("p",undefined,copy(`Install ${snapshot.offer.version} first.`,`Zuerst ${snapshot.offer.version} installieren.`)));
 footer.append(button(copy("Close","Schließen"),close));dialog.append(footer);document.body.append(dialog);dialog.addEventListener("close",()=>{dialog.remove();restoreFocus(opener);},{once:true});dialog.showModal();footer.querySelector<HTMLButtonElement>("button")?.focus();
 }
 return ()=>{const root=element("section","settings-stack");if(!transport.updateSettings||!transport.updateCheck)return root;
 if(!loaded){loaded=true;void operation(()=>transport.updateSettings!());}
 const s=snapshot?.settings;
 if(s){const label=element("label");const select=element("select");select.setAttribute("aria-label",copy("Update channel","Update-Kanal"));for(const channel of ["stable","beta"] as const){const option=element("option",undefined,channel==="stable"?"Stable":"Beta");option.value=channel;select.append(option);}select.value=s.channel;select.dataset.focusKey="update-channel";select.disabled=busy;select.addEventListener("change",()=>void save({channel:select.value as "stable"|"beta"}));append(label,document.createTextNode(copy("Channel ","Kanal ")),select);root.append(label);
 for(const [field,en,german] of [["autoPatch","Automatic patch updates","Patch-Updates automatisch"],["held","Hold this version","Version halten"],["checkOnStart","Check on start","Beim Start prüfen"]] as const){const label=element("label","quit-choice");const input=element("input");input.type="checkbox";input.dataset.focusKey=`update-${field}`;input.checked=s[field];input.disabled=busy;input.addEventListener("change",()=>void save({[field]:input.checked}));append(label,input,document.createTextNode(copy(en,german)));root.append(label);}
 const quiet=element("fieldset");quiet.append(element("legend",undefined,copy("Quiet hours (local time)","Ruhezeit (Ortszeit)")));for(const index of [0,1] as const){const label=element("label");const input=element("input");input.type="number";input.min="0";input.max="23";input.dataset.focusKey=`update-hour-${index}`;input.value=String(s.quietHours[index]);input.disabled=busy;input.addEventListener("change",()=>{const hours:[number,number]=[...s.quietHours];hours[index]=Number(input.value);void save({quietHours:hours});});append(label,document.createTextNode(copy(index===0?"From ":"To ",index===0?"Von ":"Bis ")),input);quiet.append(label);}root.append(quiet);
 }
 root.append(element("p",undefined,copy("Checks at most every six hours. Automatic patches wait for quiet hours and an idle harness.","Prüfung höchstens alle sechs Stunden. Automatische Patches warten auf die Ruhezeit und einen inaktiven Harness.")));
 const check=button(copy("Check for updates","Nach Updates suchen"),()=>void operation(()=>transport.updateCheck!()),"primary");check.disabled=busy;root.append(check);
 if(snapshot?.release&&snapshot.offer.action!=="none")root.append(button(copy(`View ${snapshot.release.version}`,`${snapshot.release.version} ansehen`),offer));
 if(failed){const error=element("p",undefined,copy("Update check failed. Nothing was installed.","Update-Prüfung fehlgeschlagen. Es wurde nichts installiert."));error.setAttribute("role","alert");root.append(error);}
 return root;};
}
