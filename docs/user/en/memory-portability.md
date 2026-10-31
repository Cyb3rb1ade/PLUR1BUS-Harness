# Memory portability: prompt import and export

You can import memories from other AI assistants (ChatGPT, Claude, Gemini, Grok, Copilot, Le Chat) using a copyable export prompt, and export your PLUR1BUS memories in the same portable format. The German version of this page is [../de/gedaechtnis-portabilitaet.md](../de/gedaechtnis-portabilitaet.md).

## How prompt import works

Many chat assistants store conversational context or explicit memory items, but provide no direct database export. PLUR1BUS solves this using a standardized export prompt:

1. In the Web UI under **Import** (`#/import`), select the tile **From another AI assistant**.
2. Select your assistant (ChatGPT, Claude, Gemini, Grok, Copilot, Le Chat, or Other).
3. Copy the displayed prompt and paste it into a new chat with your assistant.
4. Copy the assistant's reply and paste it into the text box in PLUR1BUS.
5. If the assistant's reply was cut off with `STATUS: MORE`, click **Add another part** to paste subsequent parts.
6. Click **Preview** to parse the entries and curate their destinations.

## Reviewing and assigning targets

Every extracted entry belongs to one of six categories:

* **Instructions**: behavioral rules and preferences ("always do X", "never do Y"). To prevent prompt-injection attacks from foreign text, instructions never take effect immediately; they are created as proposals that you review and approve individually.
* **Identity**: personal name, location, languages, interests.
* **Career**: roles, companies, professional skills.
* **Preferences**: personal tastes, tool and working-style preferences.
* **Projects**: specific projects built or committed to.
* **Other**: miscellaneous memories.

You can assign each entry to:
* **Do not import** (`skip`): entry is ignored.
* **My Memory** (`user`): stored in your personal user scope, available to your agents in conversation with you.
* **Selected agents** (`agent`): stored privately in an agent's own memory. Note that an agent uses agent-private memories across all its conversations, including with other people and in groups.
* **Workspace** (`workspace`): available for `Projects` entries, visible to all members of the selected workspace.

Click **Apply recommendations** to set recommended defaults across all entries.

## Redaction of secrets

The import parser automatically checks all text for credentials, passwords, and private keys. If a secret is detected, it is replaced with `[omitted]` and marked with a **Possible secret** warning. Such entries remain set to **Do not import** until you explicitly approve the redacted version.

## Reversing an import (Rollback)

Each import run generates a unique run ID and audit report. If you want to undo an import, click **Undo import (Rollback)** on the import summary page or run:

```sh
plur1bus memory import-text --rollback <runId>
```

Rollback safely removes all imported cards and discards unhandled proposals.

## Exporting memories

Under **Memories** (`#/memories`), click **Export memories** to produce a markdown export using the exact same format (`PLUR1BUS-MEMORY-EXPORT v1`). You can copy the text or download a `.md` file to transfer your context to another assistant.
