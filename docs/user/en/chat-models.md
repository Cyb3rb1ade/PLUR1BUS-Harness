# Chat models and reasoning levels

Each chat can use its own model profile, also a chat that is not remembered. From the next release you can set the reasoning level (how much the model thinks before it answers) per chat as well. The German version of this page is [../de/chat-modelle.md](../de/chat-modelle.md).

## How to

### Web UI

1. Open **Chat** (`#/chat`) and open a conversation.
2. **Switch the model:** in the chat head, type the name of a configured model profile in **Model profile** and choose **Preview model switch**. Read the warning: the prompt cache is rebuilt, and cache writes and different model costs may apply. Choose **Confirm model switch** to apply it; the new profile is used from the next reply.
3. **Model and reasoning, from the next release:** the chat head has two selects, **Model** and **Reasoning**. Models that are locked or not available stay in the list, disabled, with the reason. The reasoning select offers only the levels the model supports:
   - **Default (provider):** nothing is sent; the provider decides.
   - **Off**, **Minimal**, **Low**, **Medium**, **High**, **Extra high**: increasing depth of thinking.
   A change applies from the next reply and cannot be made while a reply is running. A short hint tells you when a higher level costs more.
4. **Chats that are not remembered:** in **New chat** (`#/chat/new`), switch on **Don't remember this chat** (`memoryMode: "incognito"`) before the first message. It cannot be changed afterwards.

### CLI

List the model catalog:

```sh
plur1bus model list
```

Chat with a model profile of your choice. The command warns about the cache and asks before it switches; `--yes` confirms for scripts. `--no-memory` starts a chat that is not remembered.

```sh
plur1bus chat --model <PROFILE> --no-memory
```

List your chat sessions and inspect one:

```sh
plur1bus session list
plur1bus session show <ID>
```

## Good to know

- **Reasoning levels (from the next release):** the scale is default, off, minimal, low, medium, high and extra high. A model offers only some of them. If your choice is not offered, the nearest supported level is used and the chat says so, never silently. A model without a reasoning setting ignores the choice, and the provider decides. A model switch alone keeps the chosen level.
- **Cost:** reasoning tokens are billed as output tokens, so a higher level can use more tokens per reply. For models with a token budget the chat shows how many output tokens thinking can add at most; Plur1bus never shows prices. The first reply after a switch can cost more because the cache is rebuilt.
- **People only:** switching the model of a chat is reserved for people. Agents and WebMCP tools cannot change it.
- **Local only (from the next release):** if "Local only" applies to the agent, cloud profiles are listed as locked and refused ([privacy.md](privacy.md)).
- **Not remembered:** such a chat saves nothing to memory. Its transcript and its model and reasoning choice stay in memory only and are not written to disk.

## Error messages

- `E_NOT_AVAILABLE` with reason `model-profile-unavailable`: the profile is not configured. Check the profile names in [providers.md](providers.md).
- `E_DENIED` with reason `agent-principal`: an agent or tool tried to change the chat's model; only a person may.
- `E_CONFLICT`: the choice was changed elsewhere in the meantime. From the next release the reasons are `stale-model-preview` (look at the current state and choose again) and `session-busy` (a reply is still running).
- From the next release: `E_DENIED` with reason `local-only` (the profile is cloud-based while "Local only" applies), `E_NOT_AVAILABLE` with reason `model-unavailable`, and `E_INVALID_PARAMS` for a reasoning level that is not on the scale.

## Next

- Manage model profiles and providers: [providers.md](providers.md)
- Privacy and Local only: [privacy.md](privacy.md)
- Managing long conversations: [long-conversations.md](long-conversations.md)
