# Managing secrets

Plur1bus provides a dedicated secret store for sensitive API keys and tokens. Secrets are isolated from the main configuration, masked in all log outputs, and accessible to agents only by name. The German version of this page is [../de/secrets.md](../de/secrets.md).

## How to ("So geht's")

### Web UI

1. Open **Settings → Secrets** (`#/settings/secrets`).
2. **Add a secret:** Choose **New Secret**. Enter the unique name (e.g. `openai/api-key`), an optional description of what the secret is used for, and paste the value into the masked password field. The value is cleared from memory as soon as you submit.
3. **Rotate a secret:** Choose **Rotate** next to an existing secret, provide the new value, and confirm.
4. **Delete a secret:** Choose **Delete**. To prevent accidents, type the exact name of the secret before confirming.

### CLI

Check which storage backend holds your secrets (system keyring or encrypted file):

```sh
plur1bus secret status
```

List all secret names (never prints values):

```sh
plur1bus secret ls
```

Store or rotate a secret by piping its value through standard input:

```sh
printf %s "$API_KEY" | plur1bus secret set <NAME>
```

Inspect metadata (timestamps and description):

```sh
plur1bus secret get <NAME>
```

Delete a secret from all storage backends:

```sh
plur1bus secret rm <NAME>
```

## Good to know ("Gut zu wissen")

- **Never in CLI arguments:** A secret value is never accepted as a command-line argument. If you type a value as an argument, Plur1bus immediately aborts with `value-in-argument` without echoing your input. Always pipe via standard input or use the Web UI.
- **What agents see (`secret_names`):** Agents are only allowed to inspect the list of secret names (`secret_names`) they are granted access to. They can never read, retrieve, or log the underlying secret values. They pass references (`apiKeyRef`) to engine tools.
- **Automatic redaction everywhere:** Secret values are automatically masked in all outputs: core logs (`core.log`), audit trails, diagnostic bundles (`1staid.bundle`), log queries (`logs.query`), and Doctor status checks.
- **Storage backends:** Plur1bus uses your operating system keyring by default (macOS Keychain, Linux Secret Service, Windows Credential Manager). If no keyring daemon is available, it uses an encrypted local file.

## Error messages ("Fehlermeldungen")

- `E_SECRET_NOT_FOUND`: The requested secret does not exist in the store. Check available names with `plur1bus secret ls`.
- `E_VALUE_IN_ARGUMENT`: A secret value was typed as a command-line argument. Use stdin piping instead: `printf %s "$VALUE" | plur1bus secret set <NAME>`.
- `E_SECRET_DENIED`: Your role or agent lacks permission to access or modify this secret.

## Next

- Use secrets with model providers: [providers.md](providers.md)
- Configure cloud embeddings: [cloud-embeddings.md](cloud-embeddings.md)
- Operations and diagnostic bundles: [operations.md](operations.md)
