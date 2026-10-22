# Managing secrets

Plur1bus keeps API keys and tokens in a secret store, separate from the configuration. A value can be written and replaced, but it is never shown again. Only the owner can use the secret store. The German version of this page is [../de/secrets.md](../de/secrets.md).

## How to

### Web UI

1. Open **Settings → Secrets** (`#/settings/secrets`). The page shows names and metadata only.
2. **Add a secret:** choose **Add secret**, enter the name (for example `openai/api-key`) and paste the value into the masked field. The value is cleared as soon as you save. From the next release there is also an optional one-line description of what the secret is for.
3. **Rotate a secret:** choose **Rotate**, enter the new value and confirm with **Rotate now**. The old value stops working at once and its leases are revoked.
4. **Delete a secret:** choose **Delete** and confirm. The secret is removed from every backend and its leases are revoked; anything that uses it stops working.

### CLI

Check which backend holds your secrets (OS keyring or encrypted file):

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

Show metadata (backend, timestamps and, from the next release, the description):

```sh
plur1bus secret get <NAME>
```

Delete a secret from every backend (`--yes` is required outside a terminal):

```sh
plur1bus secret rm <NAME>
```

From the next release, `secret set` also takes `--description` with a one-line text of at most 200 characters. Without it, a rotation keeps the stored description; an empty text removes it.

## Good to know

- **Never in an argument:** a secret value is never accepted as a command-line argument. If you type one, the command refuses without echoing it; treat what you typed as exposed (shell history, process list) and rotate it. Pipe the value through standard input, or use the web UI. The value may be up to 65536 bytes, and one trailing newline is removed.
- **Names:** letters, digits and `. _ : / @ -`, starting with a letter or digit, at most 128 characters.
- **What agents see (`secret_names`):** the tool `secret_names` lists the names, scope and presence of the secrets that the agent's own configuration refers to, such as a channel it serves or the provider of its model profile. It never shows a value, a length or a prefix, and an agent cannot ask about another agent. From the next release it also shows the description.
- **Short values:** a value of fewer than 8 characters is stored like any other, but the log redactor does not mask values that short, so it could appear in a log line. The CLI then prints a note and the web UI shows a notice; the JSON result carries a `warning` with the code `short-value-unmasked`. Prefer a longer value where the service allows it.
- **Masked in output:** secret values the core holds are masked in its log output and in the audit trail and reports built from it, and a retired value stays masked after a rotation or deletion. The diagnostic bundle (`plur1bus 1staid bundle`) never contains secrets.
- **Backends:** the OS keyring (macOS Keychain, Linux Secret Service, Windows Credential Manager) comes first. If none is usable, an encrypted file is used, but only when `secrets.fileFallback.enabled` is on. Without a backend, secret storage is not available.
- **Revealing a value:** `plur1bus secret get <NAME> --reveal` prints the value. It is the only command that does, only the owner can run it, and every call is audited.

## Error messages

- `E_NOT_FOUND` (reason `not-found`): no secret has this name. Check the names with `plur1bus secret ls`.
- `E_INVALID_PARAMS` with reason `value-in-argument`: a value was typed as an argument. Pipe it through standard input instead. The reason `value-from-stdin` means standard input is a terminal; the reason `stdin-unreadable` means it could not be read. The reasons `invalid-name` and `invalid-value` mean the name or value is malformed (an empty value, a value with a NUL character, or one over the size limit); a short value is not an error. From the next release, `invalid-description` means the description is too long, has more than one line, or contains the secret value.
- `E_DENIED` (reason `denied`): secret operations are for the owner only.
- `E_NOT_AVAILABLE` with reason `no-backend` or `backend-unavailable`: no keyring is usable and the file fallback is off, or the backend cannot be reached. Turn on `secrets.fileFallback.enabled` or fix the keyring.
- `E_CANCELLED` (reason `declined`): you answered no to the confirmation of `secret rm`; nothing was changed.

## Next

- Use secrets with model providers: [providers.md](providers.md)
- Cloud embeddings and the environment variable for their key: [cloud-embeddings.md](cloud-embeddings.md)
- Operations and diagnostic bundles: [operations.md](operations.md)
