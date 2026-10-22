/** Native update offers share a small guarded view state with the progress screens. */
export type UpdateModel={state:"idle"|"available"|"later"|"skipped"|"installing"|"done"|"rolledBack"|"recoveryFailed";version:string|null;held:boolean;step?:string};
export type UpdateAction={type:"offer";version:string}|{type:"hold";held:boolean}|{type:"install"|"later"|"skip"|"done"|"rolledBack"|"recoveryFailed"}|{type:"step";step:string};
export function initialUpdate():UpdateModel{return {state:"idle",version:null,held:false};}
/** Completions cannot manufacture an update without a verified offer. */
export function transition(model:UpdateModel,action:UpdateAction):UpdateModel{
 if(action.type==="hold")return {...model,held:action.held};
 if(action.type==="offer")return model.state==="installing"?model:{...model,state:"available",version:action.version};
 if(action.type==="step")return model.state==="installing"?{...model,step:action.step}:model;
 if(model.state==="available"&&!model.held){if(action.type==="install")return {...model,state:"installing"};if(action.type==="later")return {...model,state:"later"};if(action.type==="skip")return {...model,state:"skipped"};}
 if(model.state==="installing"&&["done","rolledBack","recoveryFailed"].includes(action.type))return {...model,state:action.type as "done"|"rolledBack"|"recoveryFailed"};
 return model;
}
/** Plain paragraphs and lists only: remove executable markup, never create anchors. */
export function notesBlocks(notes:string):Array<{kind:"paragraph"|"list";text:string}>{
 const plain=notes.slice(0,16384).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,"").replace(/<[^>]*>/g,"").replace(/\[([^\]]+)\]\([^)]*\)/g,"$1");
 return plain.split(/\r?\n/).filter(line=>line.trim()).map(line=>({kind:/^\s*[-*] /.test(line)?"list":"paragraph",text:line.replace(/^\s*[-*] /,"")}));
}
export type UpdatePreferences={channel:"stable"|"beta";held:boolean;autoPatch:boolean;quietHours:[number,number];checkOnStart:boolean};
export type Release={version:string;channel:string;kind:string;security:boolean;date:string;notes:{de:string;en:string};migrationNote?:{de:string;en:string};minFromVersion:string};
export type UpdateSnapshot={settings:UpdatePreferences;release:Release|null;offer:{action:"none"|"show"|"autoInstall"|"needsIntermediate";version?:string};storeBuild:boolean;installAvailable:boolean};
/** The shell's IPC error codes for a release that did not pass its checks (src-tauri/src/updates.rs, `UpdateError::code`): the
 * signature, the SHA-256 pin, and the manifest. A rejected check or install with one of them is never offered for install anyway. */
export const VERIFY_FAILURE_CODES=["update-signature","update-digest","update-manifest"] as const;
export function isVerifyFailure(error:unknown):boolean{return typeof error==="string"&&(VERIFY_FAILURE_CODES as readonly string[]).includes(error);}
/** The section of docs/desktop.md that explains how updates are signed and checked. */
export const UPDATE_VERIFY_DOCS="https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/blob/main/docs/desktop.md#signed-desktop-update-metadata-wp10";
/** Download progress the shell reports while `update_install` runs (`desktop-update-progress`). `total` is null while the server sends no length. */
export type UpdateProgress={downloaded:number;total:number|null};
/** The payload crosses the IPC boundary: anything but two finite, non-negative numbers is dropped. */
export function parseUpdateProgress(payload:unknown):UpdateProgress|null{
 if(typeof payload!=="object"||payload===null)return null;
 const {downloaded,total}=payload as Record<string,unknown>;
 const count=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>=0;
 if(!count(downloaded))return null;
 return {downloaded,total:count(total)&&total>0?total:null};
}
/** Whole percent for a known length, capped at 100; null while the length is unknown. */
export function progressPercent(progress:UpdateProgress):number|null{
 return progress.total===null?null:Math.min(100,Math.floor(progress.downloaded*100/progress.total));
}
