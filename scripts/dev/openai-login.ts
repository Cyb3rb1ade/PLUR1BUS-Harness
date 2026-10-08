// Manual opt-in only. Never run by tests, a shipped installer, or the Core process.
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { AuthService, createOpenAIHttp } from '../../packages/core/src/openai-auth/index.ts';
import { createAuthSecretStore } from '../../packages/core/src/auth/secret-store.ts';
import { createCoreSecretStore } from '../../packages/core/src/secrets/runtime.ts';
import { layout } from '../../packages/core/src/paths.ts';
import { createPlatformCapabilities } from '../../packages/core/src/platform.ts';
import { createEgress } from '../../packages/core/src/egress/service.ts';
if (process.env.PLUR1BUS_OPENAI_LOGIN_LIVE !== '1') throw new Error('Set PLUR1BUS_OPENAI_LOGIN_LIVE=1 for this manual real-provider test.');
const home = process.argv[2]; if (!home) throw new Error('Provide a dedicated test home.');
const paths = layout(resolve(home)); await mkdir(paths.home, { recursive: true, mode: 0o700 });
const platform = createPlatformCapabilities();
const secrets = createCoreSecretStore({ layout: paths, securePath: platform.securePath, fileFallback: () => false });
const egress = createEgress({ config: () => ({ allowHosts: ['auth.openai.com','api.openai.com'], allowPorts: [443], allowLoopback: false }) });
const principal = { owner: 'local-owner', user: 'local-owner', agentOwner: 'local-owner', deployment: 'local' as const };
const auth = new AuthService({ store: createAuthSecretStore(secrets), http: createOpenAIHttp({ egress }), clock: { now: Date.now }, audit: event => { console.error('auth.openai.' + event.kind); } });
try {
  const login = await auth.startLogin({ principal });
  console.log('Open this authorization URL in your browser:\n' + login.authorizeUrl.value());
  const credential = await auth.awaitLogin(login.loginId, principal);
  console.log(JSON.stringify({ credential, models: await auth.models(credential.id, principal) }));
} finally { await auth.close(); }
