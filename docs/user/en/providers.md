# Model providers and profiles

This page explains how to sign in to providers, how to choose models, how fallback behaves, how to use local models, and
what the error classes mean. The technical reference is [../../providers.md](../../providers.md); the German version of
this page is [../de/providers.md](../de/providers.md).

## Sign in to a provider

Sign-in goes through `plur1bus login`. For OpenAI you can sign in with your ChatGPT account or store an API key. All other
providers use an API key.
The command talks to the core. If the core is not running, it fails with `E_CORE_UNAVAILABLE`; start it with
`plur1bus daemon start`.

Sign-in is still experimental. Signing in through the web interface is not available yet; everything runs on the command
line.

### Sign in with ChatGPT

1. Start the sign-in. For ChatGPT the provider is `openai`:

   ```sh
   plur1bus login <provider>
   ```

2. The command prints an address and tries to open the browser. Sign in to ChatGPT there and confirm the access.
3. The command then reports the saved sign-in: its ID, workspace and expiry. The token itself is never printed.

The sign-in waits 600 seconds by default. Change this with `--timeout <seconds>`. Ctrl-C cancels; then nothing is saved.
If your subscription's allowance is used up, Plur1bus reports it and does not quietly switch to another billing route.

### Without a browser: servers, SSH, containers

This section applies only to the ChatGPT sign-in with OpenAI. With `--no-browser` the command only prints the address and
opens no browser:

```sh
plur1bus login <provider> --no-browser
```

If Plur1bus runs on a machine without a browser, you can forward the callback port over SSH to your own computer. The
command prints the port in its output; in the example it is 49152. Run the tunnel from the machine with the browser:

```sh
ssh -L 49152:127.0.0.1:49152 <user>@<host>
```

Without this tunnel the browser ends on a page that cannot be reached. Then use `--paste`: copy the complete address from
the address bar of that page and paste it into the prompt the command shows:

```sh
plur1bus login <provider> --no-browser --paste
```

The address contains the sign-in code. Plur1bus accepts only the address of this one sign-in, does not store it and does
not print it.

### API keys

Other providers (Anthropic, Google, Gemini, xAI, OpenRouter, Together, fal, Replicate, ElevenLabs) use an API key. It is
read from standard input, never passed as an argument:

```sh
printf %s "$ANTHROPIC_API_KEY" | plur1bus login anthropic
```

Plur1bus stores the key as a secret named `<provider>/api-key` (change the name with `--name`). The command prints only
that name. In the configuration, refer to it with `apiKeyRef`, never to the key itself.

If you ever typed a key as an argument, the command refuses it (`value-in-argument`). Then treat the key as exposed and
create a new one.

### Manage sign-ins

```sh
plur1bus login status
plur1bus login list
plur1bus login logout <id>
```

- `status` shows the saved sign-ins and sign-ins in progress.
- `list` shows the ID, workspace, expiry, and whether a new sign-in is needed.
- `logout` removes a sign-in together with its local token. The ID may be a unique beginning of at least eight
  characters.

The keys themselves are kept by the secret store: `plur1bus secret status` shows which store is in use.

## Profiles

A **profile** is a named, ordered list of models. The first one is tried first; if it fails for a reason that another
model could fix, the next one is tried. Profiles live under `modelProfiles` in `config.json`:

```json
{
  "modelProfiles": {
    "default": {
      "candidates": [{ "model": "openai/gpt-4.1" }, { "model": "gemini/gemini-2.5-pro" }, { "model": "ollama/llama3.1:8b" }],
      "params": { "temperature": 0.2, "maxTokens": 4096 }
    }
  }
}
```

- A model is written `provider/model`. Everything after the first `/` is the model id.
- The order of the list is the priority.
- `params` set sampling defaults for the profile; anything a request sets itself wins.
- A profile called `default` is used when nothing else is named. If you configure none, one is built from the providers
  that have a default model.
- A typo is reported with its place in the file, for example
  `modelProfiles.fast.candidates[1].model: unknown provider "opnai"`. All problems are listed at once.
- `strategy: "moa"` (mixture of agents) is accepted and checked, but cannot run yet: using such a profile fails with a
  clear message instead of quietly behaving like a plain fallback list.

## When does it fall back?

| Problem | Retried | Falls back to the next model |
|---|---|---|
| Rate limit (429) | yes, waiting as long as the provider asks | yes |
| Provider overloaded or 5xx | yes | yes |
| Timeout, network failure | yes | yes |
| Wrong or missing API key | no | **no** — fix the key |
| Invalid request, content/safety block | no | **no** — another vendor would refuse it too |
| Prompt too long for the model | no | **no** |
| You cancelled | no | no |

Each model of each provider has its own breaker: if `gemini-2.5-pro` keeps failing it is skipped for a while, while
`gemini-2.5-flash` stays usable. Waiting between retries grows exponentially with random jitter; a provider that asks
for a very long wait is skipped in favour of the next model.

## Local models (Ollama, LM Studio)

Ollama (`127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234`) are found automatically and need no key. If one is not
running, it simply counts as **unavailable** and the next model in the profile is used; nothing crashes and startup is
not delayed. No credentials are ever sent to a local server. Using a server on another machine needs an explicit
setting and an egress allowance.

## Error classes

`auth`, `rate_limit`, `overloaded`, `context_length`, `invalid_request`, `network`, `timeout`, `aborted`, `unknown`.
They are the same for every provider; raw provider errors are not shown, and API keys never appear in error messages
or logs.

## Token counts

Providers report different token details. If one does not report a number, it is shown as *unknown*, not as 0.

## When something goes wrong

Sign-in errors come with a `reason` (the full table is in
[openai-auth.md](../../openai-auth.md#cli-and-rpc-login)).

| Error | Meaning | What to do |
|---|---|---|
| `E_CORE_UNAVAILABLE` | The core is not running. | `plur1bus daemon start`, then sign in again. |
| `E_CONFLICT`, `login-timeout` | The sign-in was not completed in time. | Start again; give more time with `--timeout` if needed. |
| `E_CONFLICT`, `port-in-use` | The callback port is taken. | Close the other program and sign in again. |
| `E_DENIED`, `state-mismatch` | The pasted address does not belong to this sign-in or was changed. | Start a new sign-in and use the new address. |
| `E_DENIED`, `access-denied` | You refused the access. | Sign in again and confirm. |
| `E_NOT_FOUND`, `auth-required` | The saved sign-in has expired. | `plur1bus login <provider>`. |
| `E_NOT_AVAILABLE`, `transport-failed` | OpenAI could not be reached. | Check the network and try again later. |
| `E_STORAGE`, `persist-failed` | The secret store could not write. | Check it with `plur1bus secret status`. |
| `E_INVALID_PARAMS`, `value-in-argument` (exit 2) | A key was on the command line. | Create a new key and repeat the command with standard input. |
| Exit 130 (`E_CANCELLED`) | You cancelled with Ctrl-C. | Nothing to do; the sign-in was not saved. |
