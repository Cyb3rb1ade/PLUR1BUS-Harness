export type RuntimeItem = { id: string; kind: "apple" | "docker"; endpoint: string; source: string; engine: string; version: string; state: "ready" | "stopped" | "unavailable" | "too-old" | "wrong-mode" | "no-access" };
export type Step = "welcome" | "licences" | "runtime" | "install-runtime" | "installing" | "done" | "opened" | "error";
export const errors = {
 "runtime-missing": {message:"wizard.error.runtime-missing",retry:"runtime"},
 "runtime-too-old": {message:"wizard.error.runtime-too-old",retry:"runtime"},
 "runtime-no-access": {message:"wizard.error.runtime-no-access",retry:"runtime"},
 "wrong-mode": {message:"wizard.error.wrong-mode",retry:"runtime"},
 "digest-mismatch": {message:"wizard.error.digest-mismatch",retry:"runtime"},
 "disk-space": {message:"wizard.error.disk-space",retry:"runtime"},
 "pull-failed": {message:"wizard.error.pull-failed",retry:"runtime"},
 "start-timeout": {message:"wizard.error.start-timeout",retry:"runtime"},
 "pair-failed": {message:"wizard.error.pair-failed",retry:"runtime"},
 cancelled: { message: "wizard.error.cancelled", retry: "runtime" },
 runtime: { message: "wizard.error.runtime", retry: "runtime" },
 image: { message: "wizard.error.image", retry: "runtime" },
 storage: { message: "wizard.error.storage", retry: "runtime" },
 health: { message: "wizard.error.health", retry: "runtime" },
 pairing: { message: "wizard.error.pairing", retry: "runtime" },
} as const;
export type Wizard = { step: Step; agreed: boolean; selected: string | null; runtimes: RuntimeItem[]; operation: number; actions: number; connectionId: string | null; error: keyof typeof errors | null };
export function initialWizard(): Wizard { return {step:"welcome",agreed:false,selected:null,runtimes:[],operation:0,actions:0,connectionId:null,error:null}; }
export function agreeWizard(s: Wizard, agreed: boolean): Wizard { return {...s,agreed}; }
export function foundRuntimes(s: Wizard, runtimes: RuntimeItem[], recommended: string | null): Wizard { return {...s,runtimes,selected:s.selected ?? recommended}; }
export function advanceWizard(s: Wizard): Wizard {
 const next: Partial<Record<Step,Step>> = {welcome:"licences",done:"opened","install-runtime":"runtime"};
 let step=next[s.step];
 if(s.step==="licences"&&s.agreed) step="runtime";
 if(s.step==="runtime") step=s.selected&&s.runtimes.some(r=>r.id===s.selected&&["ready","stopped"].includes(r.state))?"installing":"install-runtime";
 if(!step) return s;
 return {...s,step,actions:s.actions+1,operation:s.operation+(step==="installing"?1:0)};
}
export function completeWizard(s: Wizard, connectionId: string, operation: number): Wizard { return s.step==="installing"&&s.operation===operation?{...s,step:"done",connectionId}:s; }
export function failWizard(s: Wizard, error: keyof typeof errors): Wizard { return {...s,step:"error",error,operation:s.operation+1}; }
export function retryWizard(s: Wizard): Wizard { return {...s,step:s.error?errors[s.error].retry:"runtime",error:null}; }
export function installerFor(platform: "mac" | "linux" | "windows", major: number | null): "apple-pkg" | "guide" | "podman-socket" | "vendor" { return platform==="mac"?(major!==null&&major>=26?"apple-pkg":"guide"):platform==="linux"?"podman-socket":"vendor"; }

export function wizardError(code:unknown):keyof typeof errors {
 const known:Record<string,keyof typeof errors>={"runtime.not-found":"runtime-missing","runtime-unavailable":"runtime-missing","runtime.too-old":"runtime-too-old","runtime.no-access":"runtime-no-access","runtime.wrong-mode":"wrong-mode","digest-mismatch":"digest-mismatch","image-digest":"digest-mismatch","storage":"disk-space","start-timeout":"start-timeout","pairing-needed":"pair-failed","keychain-error":"pair-failed","cancelled":"cancelled"};
 return typeof code==="string"?(known[code]??"pull-failed"):"pull-failed";
}
