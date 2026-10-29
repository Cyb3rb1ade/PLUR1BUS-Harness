// Real Core RPC validation and SSH/Secret Store service, with disposable memory backends and trusted role changes.
import { createInterface } from "node:readline";
import { randomBytes,createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRpcServer } from "../../src/rpc/server.ts";
import { buildSshImportMethods, createSshImportService } from "../../src/import/ssh-service.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { coreAddress } from "../../../module-api/src/paths.ts";
import { silentLogger } from "../../../module-api/src/logger.ts";
import { createSecurePath } from "../../../module-api/src/secure-path.ts";
import { buildCapabilities, RPC_VERSION } from "../../../rpc-schema/src/index.ts";
import { createRpcServer as createModuleServer, supervisorAddress } from "@plur1bus/module-api";
import { RpcError } from "../../src/rpc/errors.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";

const home=process.argv[2];
const securePath=createSecurePath();
const run=join(home,"run"); mkdirSync(run,{mode:0o700}); securePath(run,{mode:0o700});
const token=randomBytes(32).toString("hex");
writeFileSync(join(run,"core.token"),token,{mode:0o600}); securePath(join(run,"core.token"));
writeFileSync(join(run,"core.pid"),`${process.pid} 00000000-0000-4000-8000-000000000001\n`,{mode:0o600}); securePath(join(run,"core.pid"));
const store=createSecretStore({keyring:createMemoryBackend(),file:createMemoryBackend(),audit:createMemoryAuditSink(),fileFallback:()=>false});
let connections={};
let principal={userId:"owner",kind:"person",role:"owner"};
let egress={allowHosts:[],allowPorts:[443],allowLoopback:false};
let configRevision=0;
const worker=process.argv[3] ? {path:process.argv[3],sha256:createHash("sha256").update(await readFile(process.argv[3])).digest("hex"),mode:"harness"} : undefined;
const service=createSshImportService({store,audit:memoryAuditSink(),config:()=>connections,egress:()=>egress,setConnections:async value=>{connections=structuredClone(value);},person:()=>principal,worker:()=>worker});
const supervisorToken=randomBytes(32).toString("hex");
writeFileSync(join(run,"supervisor.token"),supervisorToken,{mode:0o600});securePath(join(run,"supervisor.token"));
writeFileSync(join(run,"supervisor.pid"),`${process.pid} fixture-supervisor\n`,{mode:0o600});securePath(join(run,"supervisor.pid"));
const supervisor=createModuleServer({server:"supervisor",address:supervisorAddress(home),token:supervisorToken,logger:silentLogger(),
    hello:()=>({rpc:RPC_VERSION,instanceId:"00000000-0000-4000-8000-000000000002",pid:process.pid}),methods:{
        "config.get":async({key})=>({key:key??null,tier:null,value:key==="egress"?egress:{egress},restartClass:key?"live":null,restart:key?"live":null,revision:`fixture-${configRevision}`}),
        "config.set":async({changes,ifRevision,dryRun})=>{
            if(principal.kind!=="person"||principal.role!=="owner")throw new RpcError("E_DENIED","Owner required");
            if(ifRevision!==undefined&&ifRevision!==`fixture-${configRevision}`)throw new RpcError("E_CONFLICT","Config changed");
            for(const change of changes)if(!["egress.allowHosts","egress.allowPorts"].includes(change.key)||!Array.isArray(change.value))throw new RpcError("E_INVALID_PARAMS","Invalid fixture change");
            if(!dryRun){for(const change of changes)egress={...egress,[change.key.slice(7)]:change.value};configRevision++;service.configChanged();}
            return{applied:!dryRun,dryRun:!!dryRun,revision:`fixture-${configRevision}`,changed:changes.map(change=>change.key),restart:{live:changes.map(change=>change.key),core:false,modules:[]},restarted:[],durationMs:0};
        }
    }});
await supervisor.listen();
let sourceServer;
async function control(line) {
    if (line === "start-server") {
        const key=await service.keyStatus(principal);
        sourceServer=spawn(process.argv[4],[],{stdio:["pipe","pipe","ignore"]});
        const lines=createInterface({input:sourceServer.stdout});
        let deadline;
        const ready=Promise.race([once(lines,"line").then(([line])=>JSON.parse(line)),
            new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error("source fixture timeout")),10_000);})]).finally(()=>clearTimeout(deadline));
        sourceServer.stdin.write(`${JSON.stringify({root:process.argv[5],authorizedPublicKey:key.publicKey})}\n`);
        process.stdout.write(`${JSON.stringify(await ready)}\n`);
        return;
    }
    if (line === "read") {
        const session=await service.open("source","/",principal);
        try {await session.fs.readFile("config.json",1024);} finally {await session.close();}
        process.stdout.write('{"read":true}\n');return;
    }
    if (["owner","admin","viewer"].includes(line)) principal={userId:"owner",kind:"person",role:line};
    else if (line === "agent") principal={userId:"owner",kind:"agent",role:"owner"};
    else throw Error("unsupported fixture control");
    process.stdout.write("ok\n");
}
const server=createRpcServer({address:coreAddress(home),token,logger:silentLogger(),
    methods:buildSshImportMethods(service,()=>principal),
    hello:()=>({contract:"1.12.0",rpc:RPC_VERSION,instanceId:"00000000-0000-4000-8000-000000000001",pid:process.pid,capabilities:buildCapabilities([],"core")})});
await server.listen();
process.stdout.write('{"ready":true}\n');
const input=createInterface({input:process.stdin});
input.on("line",line=>{void control(line).catch(()=>{process.stdout.write('{"fixtureError":true}\n');});});
input.on("close",()=>{void server.close().then(()=>supervisor.close()).then(()=>service.close()).finally(async()=>{
    if(sourceServer){const closed=once(sourceServer,"close");sourceServer.stdin.end();const timer=setTimeout(()=>sourceServer.kill("SIGKILL"),2000);await closed;clearTimeout(timer);}
});});
