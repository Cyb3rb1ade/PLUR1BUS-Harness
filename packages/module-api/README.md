# `@plur1bus/module-api`

`@plur1bus/module-api` is the public TypeScript API for PLUR1BUS modules. It provides the module process runtime,
the authenticated RPC client and server, configuration watching, logging, secure run-file handling, and helpers for
adoption and lifeline management. A module author normally uses `runModule` and does not implement those process
facilities directly.

## Module lifecycle

The supervisor starts a module as a separate process. `runModule` validates `modules/<name>/module.json`, takes an
exclusive per-module lock, loads its `modules.<name>` configuration, and calls the module's `start` function with a
`ModuleContext`. The context exposes the module identity, abort signal, logger, live configuration access and updates,
optional core RPC connection, and a status-detail setter.

After `start` resolves, the runtime writes the module's protected token and pid files, opens its authenticated control
endpoint, and reports the module as ready. A module may be adopted by a replacement supervisor after the old
supervisor disappears. If its stdin lifeline closes without adoption, the module is orphaned until the configured
grace period expires. Shutdown requests and process signals invoke the returned `stop` handler, then close connections,
remove run files, release the lock, and exit.

## Example

The package's test fixture demonstrates a complete, minimal module. Its entry point can be as small as:

```ts
import { runModule } from "@plur1bus/module-api";

await runModule({
  async start(ctx) {
    ctx.setDetail({ greeting: ctx.config().greeting ?? "Hello" });
    const unsubscribe = ctx.onConfig((config) => {
      ctx.setDetail({ greeting: config.greeting ?? "Hello" });
    });

    return {
      async stop() {
        unsubscribe();
      },
    };
  },
});
```

The supervisor supplies `--home` and `--module` when it starts the entry point. See
[`packages/module-fixture`](../module-fixture/README.md) for a working manifest and build/run example, and
[`docs/module-guide.md`](../../docs/module-guide.md) for the manifest, dependency graph, configuration, and lifecycle
details.

## API versioning

The module's `version` is its own release version; `apiVersion` is the module API major it targets, represented as a
canonical decimal string (for example, `"1"`). The supervisor decides whether that major is supported. The runtime
does not reject a manifest solely because its API major is outside the supervisor's supported window.

The current major is exported as `MODULE_API_VERSION`. The compatibility policy currently accepts the current major
and the immediately preceding positive major. Additive manifest fields are compatible within a major; changes that
break existing module source or its runtime contract require a new API major and corresponding supervisor support.
The JSON Schema in `schema/manifest.schema.json` is the shared source of truth for manifest validation in TypeScript
and Rust; update it in step with any manifest-contract change.
