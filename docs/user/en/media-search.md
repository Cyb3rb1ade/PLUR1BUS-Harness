# Media search

Media search lets you find images, videos and audio in your Plur1bus memory. You search with text ("a red bridge at
night") or with "find similar", which starts from a medium you already have and looks for others like it. Each result
shows a score and a caption. For video and audio, the result also shows the time segment, and you can jump to that place
in the player.

The German version of this page is [../de/mediensuche.md](../de/mediensuche.md). The page on generating images is
[../en/media.md](../en/media.md).

## Two indexes

Plur1bus keeps two separate indexes:

- **The text index** is the main index. It holds your memory entries. Media do not change it: its provider, dimension
  and fingerprint stay as they are.
- **The media index** holds images, videos and audio.

Vectors are never compared across spaces. A text-to-media search encodes your text with the text encoder of the media
model, and then compares it only with the media index. The same model can serve both indexes. It is loaded once, but the
indexes stay separate.

## Captions

Every medium gets a caption. A caption is a normal memory entry in the text index, marked as a media caption. Because it
lives in the text index, it can also be found by normal memory search. Captions are never compared with image or audio
vectors.

You choose where a caption comes from:

- **Prompt, then user, then automatic** (the default): first the caption from the prompt, if there is one, then a caption
  that a user wrote, and only if neither exists, an automatic one.
- **User only**: only captions that a person has written or edited are used.
- **Off**: no captions are created.

The provider that writes captions is local when your embedding is local. If your embedding runs in the cloud, setup asks
which provider to use for captions, and nothing is preselected. Captions are limited to 280 characters by default. You
can also turn on per-segment captions, which give each part of a video or audio file its own caption.

Anyone who is allowed to edit a medium can edit its caption. Agents cannot edit captions.

Search can also combine caption hits with media hits. This is an option of the search, off by default. It works on the
rank positions of both result lists, never on the vectors.

## Choose providers

Text and media providers are chosen independently. There is no fixed list of allowed combinations. When you save the
setup, Plur1bus checks only four things: whether the provider can handle the media type (capability), whether the model's
licence is confirmed, whether the privacy pin allows the provider, and whether the provider is available. Here are three
examples.

**Only EmbeddingGemma 2 local for text and media.** This is the simplest setup. The same local model serves the text index
and the media index, and it is loaded once. Everything, including captions, runs on your Mac.

**OpenAI for text, EmbeddingGemma 2 local for media.** OpenAI serves the text index, so your memory entries and captions
are embedded by OpenAI. OpenAI cannot serve the media index, so media indexing is always done by a provider that supports
the medium. Here that is the local model. Text queries for media search are also encoded by the local media model, so they
stay on your Mac.

**Jina text model, EmbeddingGemma 2 local for media.** The Jina model serves the text index. Jina models are licensed
CC BY-NC-4.0, which allows non-commercial use only, so you must confirm the licence for the Jina model during setup. The
media index uses the local EmbeddingGemma 2 model as before.

## Defaults for new installations

A new installation starts with these settings, all of which you can change in setup:

- EmbeddingGemma 2 local for the text index and the media index.
- All three modalities active: image, video and audio.
- Backfill automatic. Backfill is the indexing of media that have not been indexed yet. It runs in the background, can be paused,
  resumes after a restart, and honours your budget.

## Modalities and model variant

Each modality (image, video, audio) can be switched off on its own. The model variant depends on the modalities you keep,
so the model you download can change in size when you switch one on or off.

## Licences

Jina models are licensed CC BY-NC-4.0. This licence allows non-commercial use only, and the commercial use class does
not allow Jina models. Setup asks you to confirm the licence for each model before it can continue. The memory and media
step can be skipped as a whole; you can set it up later in Settings, Memory.

## Privacy pin

If the privacy pin is set, cloud providers are not used for embedding or captioning. Plur1bus sends no request to them at
all. Local providers keep working. If a cloud provider is still configured while the pin is set, the affected indexing
stops with an error (see below).

## Backfill and reindexing

Backfill starts after you enable media search and after you change the media model. While it runs, you see the progress.
You can pause it and resume it. Until backfill has finished, not every medium is searchable yet.

If your budget is used up, backfill pauses by itself and shows the reason "budget". It continues when the budget allows
again.

The media index shows four counters:

- **indexed**: media that are searchable.
- **pending**: media still waiting for indexing.
- **failed**: media that could not be indexed.
- **unsupported**: media that Plur1bus cannot process, for example because a file format or a required component is unknown.

**Reindex** indexes all media again with the current settings. It asks for confirmation first. Until it has finished,
search covers only part of your media.

## Where to find it

- **Setup**: the step "Memory & Mediensuche" (Memory & media search) chooses the providers, the modalities, the licence
  confirmations and the caption provider.
- **Settings, Memory**: the text index and the media index are shown side by side. An index status card shows the
  counters, the backfill state and the pause and resume controls. Each agent can override the media settings in its agent
  menu.
- **Media view**: the place where you search media, by text or from a medium.

## When something goes wrong

| Message | What it means | What to do |
|---|---|---|
| The provider cannot handle this media type (E_MEDIA_CAPABILITY) | The chosen provider does not support images, videos or audio. For example, OpenAI cannot serve the media index. | Choose a provider that supports this medium for the media index. |
| The licence is not confirmed (E_MEDIA_LICENSE) | The model, for example a Jina model, needs a licence confirmation that is missing. | Open setup and confirm the licence. |
| The privacy pin blocks a cloud provider (E_MEDIA_PRIVACY) | The privacy pin is set, and a cloud provider is configured for embedding or captioning. No request was sent. | Use a local provider, or remove the privacy pin if you want cloud providers. |
| The model is not available (E_MEDIA_UNAVAILABLE) | The model is not installed, a key is missing, or this engine has no media index. | Install the model, add the key, or check the engine. |
| The dimension does not match (E_MEDIA_DIMENSION) | The query and the stored media use different dimensions, or the model does not support the chosen dimension. | Reindex the media index after a model change, or choose a supported dimension. |
| The format or a component is unknown (E_MEDIA_UNSUPPORTED_KIND) | Plur1bus cannot process this file format, or a component it needs for it is missing. The medium is counted as unsupported. | Convert the file to a common format, or accept that this medium stays unsupported. |
