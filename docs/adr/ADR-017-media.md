# ADR-017 — Media generation and editing

Status: Accepted; image v0.1 and video v0.2 library/RPC/CLI implementation.
Owner decisions: 2026-10-07. Protocol inventory refreshed: 2026-10-10.

## Decision

Video belongs to v0.2. Generation and editing of photographs/videos of real people
have no additional approval gate. The requested media.generate/media.edit D109
capabilities are to be default allowed; provider moderation remains authoritative.
Human RPC retains the existing Media RBAC and object/agent authorization.

Prompt embedding is optional, with call > agent > global > false precedence.
Manifest provenance remains independent of embedding. Input video metadata and
inherited output location/device metadata are removed before upload/publication.

Provider priority is gateways (OpenRouter, Replicate, fal), xAI, OpenAI, Google.
Model IDs and model capability profiles come from config or discovery, never a
hardcoded video model. Retired/unavailable protocols advertise capability false.
On 2026-10-10 OpenAI's Sora API is retired (SDK shutdown date 2026-09-24), so its
video capabilities are false; the existing image implementation is unaffected.

## Implementation

Extend the existing JobRunner, OutputStore, media.generate/media.edit RPC methods,
media.job/output methods and Rust media commands. No second job service or RPC
family. Video capabilities cover text/image/video input, duration, resolution,
aspect, FPS and audio. Gateway inputs must match a published model schema.

Downloads stream into private staging with an enforced byte limit, then local
ffprobe/ffmpeg measures/remuxes the supported MP4/MOV/WebM container, strips
inherited metadata and creates a PNG poster. Publication remains atomic. A host
must install ffmpeg and ffprobe. No executable shell or network media protocol is
used. Missing tools fail closed. Unsupported output-codec/container combinations
are refused; this release remuxes rather than silently transcoding.

Budget admission uses videoSecond units, settlement uses measured stored duration.
Vendor cost, when returned, is retained; otherwise costStatus is unknown and a
separate dated price-table estimate is retained. Existing core PriceBook remains
responsible for money ceilings; a manifest estimate is not an authoritative bill.
Uncertain submitted video failures keep their budget reservation for reconciliation.

## Integration boundary

The strict source allowlist excludes composition/index.ts, composition/media.ts
and policy/capabilities.ts. Wiring media.video.* into the live host and adding
the missing media D109 entries requires those three narrow additions. Until
the owner permits them, library/RPC/CLI use explicit host adapter definitions,
and media agent tools are registered only if their capabilities exist.
This is an open integration requirement, not completed agent acceptance.

## Verification and consequences

Fake-server contract tests cover each available protocol, polling/checkpoints,
cancellation, 429/Retry-After, auth, refusal, invalid/oversized output. Portable
store tests inject a processor; native tests create only synthetic local clips.
Cloud generation is live-unverified. Google video-to-video is Veo extension of
eligible generated clips, not arbitrary general-purpose video editing. OpenRouter
supports text/image input but no advertised video editing endpoint. Remote cancel
is attempted only for documented Replicate/fal endpoints; other providers may
continue rendering/billing after local cancellation.

Production integration and scoped local verification are described in
[media.md](../media.md) and [media-adapters.md](../media-adapters.md).
