// Build the sidecar for the same target as Tauri, without any shell interpolation.
import {execFileSync} from "node:child_process";
import {copyFile,mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
export async function prepareHelper(){
 const root=fileURLToPath(new URL("../",import.meta.url));
 const host=execFileSync("rustc",["-vV"],{encoding:"utf8"}).split("\n").find(line=>line.startsWith("host: "))?.slice(6);
 const target=process.env.TAURI_ENV_TARGET_TRIPLE??process.env.CARGO_BUILD_TARGET??host;
 if(!target||!/^[a-z0-9_-]+$/.test(target))throw new Error("Helper target unavailable");
 const release=process.env.TAURI_ENV_DEBUG==="false";
 const args=["build","--locked","-p","plur1bus-host","--target",target,...(release?["--release"]:[])];
 execFileSync("cargo",args,{cwd:root,stdio:"inherit"});
 const extension=target.includes("windows")?".exe":"";
 const directory=join(root,"src-tauri","binaries");await mkdir(directory,{recursive:true});
 const targetRoot=process.env.CARGO_TARGET_DIR??join(root,"target");
 await copyFile(join(targetRoot,target,release?"release":"debug",`plur1bus-host${extension}`),join(directory,`plur1bus-host-${target}${extension}`));
}
