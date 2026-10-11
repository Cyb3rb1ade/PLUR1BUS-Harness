# @plur1bus/media

Dependency-free Node media library. Provides image/video adapter protocols,
capability selection, the shared durable JobRunner, OutputStore and cost estimates.
Consumes provider HTTP, local ffmpeg/ffprobe for video processing, and optional
budget/job persistence ports. The library does not register RPC methods itself;
core media.generate/edit and media.job/output surfaces consume these ports.

Video generation requires an explicit `HttpAdapterConfig.video` profile, including
its configured model and supported capabilities. Replicate discovers its input
schema, fal takes a published inputSchema, and OpenRouter validates its video
model inventory. OpenAI video is unavailable after Sora retirement. Nothing
adds an approval gate for real-person photographs or videos.

```ts
import { createAdapter, OutputStore, JobRunner, FileJobPersistence } from '@plur1bus/media';
const adapter = createAdapter({
  id: 'xai', model: configuredVideoModel, apiKey: leasedKey,
  downloadHosts: configuredDownloadHosts,
  video: { textToVideo: true, imageToVideo: true, videoToVideo: true,
    durationSeconds: [1, 15], resolutions: ['480p', '720p'] },
});
const runner = new JobRunner(new FileJobPersistence(jobRoot),
  new OutputStore(outputRoot, { maxVideoBytes: 512 * 1024 * 1024 }), [adapter], budgetPort);
const job = await runner.enqueue(adapter.id, { kind: 'video', prompt: 'A forest', durationSeconds: 4 });
await runner.run(job.id, signal);
```

Config-schema owns media.video.*; these keys restart core. The existing settings
conversion helper accepts media.video.adapters profiles under the same media
settings object. Live host composition must supply validated configuration and
lease credentials without persisting them in requests. Library APIs contain no
configuration file or secret-store access.

Run `pnpm --filter @plur1bus/media test` in the repository root. Tests use loopback
fake servers and temporary synthetic data only. Native video tests generate local
clips and skip if ffmpeg/ffprobe are absent. See [media](../../docs/media.md),
[adapter protocols](../../docs/media-adapters.md), and
[ADR-017](../../docs/adr/ADR-017-media.md) for capabilities, limitations and privacy.
