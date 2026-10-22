import { readConfigFile } from "../config-load.ts";
import { createEngineFetch, createEngineSecrets } from "../engine-host-ports.ts";
import { createEgress } from "../egress/service.ts";
import { layout } from "../paths.ts";
import { createPlatformCapabilities } from "../platform.ts";
import { createCoreSecretStore } from "../secrets/runtime.ts";

/** Standalone imports/probes are engine owners too. Use the target home's policy and keys, even with a scratch store. */
export function importEnginePorts(home: string) {
  const l = layout(home), config = () => readConfigFile(l.configPath);
  const egress = createEgress({ config: () => config().egress });
  const store = createCoreSecretStore({ layout: l, securePath: createPlatformCapabilities().securePath, fileFallback: () => config().secrets.fileFallback.enabled });
  return { fetch: createEngineFetch(egress), secrets: createEngineSecrets(store) };
}
