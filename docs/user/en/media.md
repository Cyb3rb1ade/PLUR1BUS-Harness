# Generating images

With `plur1bus media` you generate and edit images. Each request runs as a job: you start it, Plur1bus fetches the result
from the provider and stores the image privately in your own store, where it stays until you delete it. You can generate
images with cloud providers or locally on your Mac.

Video is in progress and not available yet. Technical details are in [../../media.md](../../media.md) and
[../../media-adapters.md](../../media-adapters.md). The German version of this page is [../de/media.md](../de/media.md).

## Set up a provider

A provider is an **adapter**. Cloud adapters (OpenAI, Google, OpenRouter, fal, Replicate, Together, xAI) need a key.
Local adapters (Draw Things, Core ML) do not.

To see an overview of the adapters:

```sh
plur1bus media adapters
```

### Cloud: OpenAI as an example

1. Store the key as a secret. The value comes from standard input:

   ```sh
   printf %s "$OPENAI_API_KEY" | plur1bus secret set media/openai
   ```

2. Point the configuration at the name, not at the key:

   ```sh
   plur1bus config set media.adapters.openai.apiKeyRef media/openai
   ```

The adapter switches on as soon as the name points to a stored secret. To switch it off even when a key is present, run
`plur1bus config set media.adapters.openai.enabled false`. The other settings (model, timeout, concurrent jobs) are in
[../../config.md](../../config.md).

### Local: Draw Things

Draw Things provides an interface at `127.0.0.1:7860` on your Mac. Switch the adapter on and enter the model name as Draw
Things shows it:

```sh
plur1bus config set media.adapters.drawthings.enabled true
plur1bus config set media.adapters.drawthings.model <model-file>
```

### Local: Core ML

The Core ML adapter works only on macOS with an Apple Silicon chip. You build the helper from the source code:

```sh
swift build -c release --package-path tools/coreml-sd-helper
```

Then you enter the absolute path of the finished program and the name of a compatible model folder. Plur1bus does not
download models by itself.

```sh
plur1bus config set media.adapters.coreml.binary /absolute/path/tools/coreml-sd-helper/.build/release/media-coreml
plur1bus config set media.adapters.coreml.model <model-folder>
plur1bus config set media.adapters.coreml.enabled true
```

## Generate an image

```sh
plur1bus media generate "A forest in fog, photograph" --adapter openai --wait --out forest.png
```

- `--adapter` decides which provider makes the image.
- `--count 2` generates several images in one job. `--width` and `--height` set the size, if the provider allows it.
- `--wait` waits up to ten minutes and shows progress on the error output. When it returns, the job is finished. If the
  job runs longer, it stays queryable.
- `--out forest.png` writes the file. An existing file stays unchanged; the command creates a new one.

Without `--wait`, the command only returns the job ID. Check the status with:

```sh
plur1bus media job <job-id>
```

### Write metadata into the image

The prompt, parameters and model can be embedded in the image itself. This is **off** by default. For a single job, turn it
on with `--embed-metadata true`:

```sh
plur1bus media generate "A forest in fog" --adapter openai --embed-metadata true --wait --out forest.png
```

Regardless of this, Plur1bus always keeps a manifest with all details about the job.

## Edit an image

Change a stored image with `media edit`. For the reference, name the ID of an output from your store, not a file path:

```sh
plur1bus media edit "Add snow" --reference <output-id> --wait --out snow.png
```

With `--mask <output-id>` you mark the area to change. Only some adapters support masks, for example OpenAI, fal and
Replicate (depending on the model). An adapter that cannot do it rejects the job before sending it.

## Jobs and outputs

| Command | What it does |
|---|---|
| `plur1bus media jobs` | Shows your jobs. With `--agent main`, only those of one agent. |
| `plur1bus media job <job-id>` | Shows the status, error and result of a job. |
| `plur1bus media cancel <job-id>` | Cancels a job. The provider is stopped too where possible; a job already under way may still be billed by the provider. |
| `plur1bus media outputs` | Shows your stored images. With `--adapter`, filters by provider. |
| `plur1bus media output <output-id> --out image.png` | Saves a stored image to a file. |
| `plur1bus media rm <output-id>` | Deletes a stored image. The job stays in the history. |

A job goes through the states `queued` and `running`, and ends in `succeeded`, `failed` or `cancelled`.

## Costs and limits

- Cloud providers bill their images themselves. Plur1bus only estimates the costs; only OpenRouter reports actual costs.
- If the budget is used up, Plur1bus does not send the job to the provider at all.
- Reference and mask images lose their metadata before sending, for example the location from EXIF.
- If a provider refuses a job on content grounds, it is not routed around through another provider and not retried
  automatically.

## When something goes wrong

Errors of a job appear as an error code in `plur1bus media job <job-id>`. The most common:

| Error code | Meaning | What to do |
|---|---|---|
| `backend_unavailable`, reason `auth_invalid` or `auth_forbidden` | The provider rejected the key. | Check the adapter's secret name and renew the key. |
| `backend_unavailable` (no reason) | The provider is not reachable right now. | Try again later. |
| `content_policy` | The provider refused the content. | Change the prompt; there is no automatic retry. |
| `quota` | The quota or budget is used up. | Check the provider's quota or the budget. |
| `too_large` | A reference is too large. Transfer is limited to 16 MiB. | Use a smaller file. |
| `unsupported_parameter` | The adapter cannot do the size or a parameter. | Choose another size or another adapter. |
| `timeout` | The provider did not answer in time. | Query the job; it stays retrievable. |
| `interrupted` | The job was interrupted before its result was stored. | Plur1bus does not resend the job. Start a new one. |

If the core is not running, every command reports `E_CORE_UNAVAILABLE`. Start it with `plur1bus daemon start`.
