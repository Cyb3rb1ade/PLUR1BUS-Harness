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
