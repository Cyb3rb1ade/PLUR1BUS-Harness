# Media library

Open **Build → Library** (`#/library`). The German version is [bibliothek.md](../de/bibliothek.md).

## Availability and permissions

**The library's Web connection is incomplete in this version.** The Web API refuses the initial media-list request. The page therefore shows **Media service is not available on this harness** and offers a retry. The sections below explain the controls already present for a version with an available media connection. They do not promise that these browser workflows work in this build. The existing CLI alternative is described in [media.md](media.md).

The permission table allows Owner, Admin, Operator, Member and Viewer to read media. Access to the agent that created the medium is checked as well: Members and Viewers need a use right; lists omit inaccessible agents. Owner, Admin, Operator and Member may generate, edit, cancel and delete. Operators and Members also need a use right on the agent; Viewers cannot perform these actions. Changing captions is also limited to those four roles and requires edit rights on the medium. A visible button does not replace the permission check.

## Gallery and preview

- **Type** filters all media, images, videos or audio. The gallery initially shows 24 entries; **Show more** adds another 24 each time.
- A card shows its prompt, any caption, agent and, where present, adapter. Open it with **Preview**, by clicking its preview area, or by pressing Enter or Space while that area has focus.
- The preview loads the stored file. Video and audio use a player; images show a preview with a download link. Expand **Manifest** to read the listed metadata.
- Use **Edit caption**, then **Save caption** or **Cancel**. The caption also supplies alternative text for images; without one, the view uses the prompt.
- **Delete** requires confirmation. The interface offers no undo for deletion.
- **Go to Media Search** opens the separate [media search](media-search.md). The gallery's type filter does not search content.

## Generate and edit

**Generate** opens a dialog. Choose the kind, adapter and model, select an agent where offered, and enter a prompt. Images or videos are offered according to the available adapters' capabilities. The dialog does not offer audio generation. A negative prompt appears for images; other parameters, such as size, count, seed or duration, depend on the adapter. Not every adapter offers every field.

**Edit** on an image or video offers only operations supported by the adapter: prompt editing, inpainting, image to video or video editing. Inpainting requires another image from the library as its mask. Audio has no Edit button.

A cloud adapter requires confirmation before sending: the prompt and selected reference media go to that provider. Privacy rules, permissions, approvals, licence confirmation and budgets can still refuse the job. The interface then shows the failure and, where available, its code and reason. See [media.md](media.md) for providers and [privacy.md](privacy.md) for privacy controls.

## Jobs and defaults

A started request appears in **Jobs**, showing its state and progress while running. **Cancel job** requests cancellation. After success, **Open result** opens the medium; **Hide** removes a finished job from this view. Alongside active jobs, the view shows up to five recent finished jobs. The job list reloads after reconnecting.

Under **Defaults**, choose a default adapter for each kind. This choice is remembered only in this browser. Only Owner and Admin can change the global **Embed the prompt in generated files** switch. It controls embedding in files; the manifest always retains the prompt independently.
