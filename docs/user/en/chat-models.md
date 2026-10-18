# Chat models and reasoning levels

In Plur1bus, you can select the active model and reasoning level (thinking depth) individually for each chat session, including temporary incognito chats. The German version of this page is [../de/chat-modelle.md](../de/chat-modelle.md).

## How to ("So geht's")

### Web UI

1. Open **Chat** (`#/chat` or `#/chat/new`).
2. In the conversation header bar, choose your options from the dropdowns:
   - **Model dropdown:** Select any configured model profile (for example `openai/gpt-4.1` or `ollama/llama3.1:8b`).
   - **Reasoning level dropdown:** Select the depth of reflection:
     - `none` (Off): Standard inference without extended reasoning.
     - `low`: Short reasoning budget for fast, lightweight deliberation.
     - `medium`: Balanced reasoning for analytical problems.
     - `high`: Deep chain-of-thought for complex coding or multi-step logic.
3. **Incognito chats ("Not remembered"):**
   - In **New Chat** (`#/chat/new`), enable the **Not remembered** switch (`memoryMode: "incognito"`).
   - In incognito mode, your model selection, reasoning setting, and conversation history are kept strictly in memory and are discarded when the window closes.

### CLI

List configured model candidates:

```sh
plur1bus model list
```

List active and recent chat sessions:

```sh
plur1bus session list
```

Inspect session configuration and model information:

```sh
plur1bus session show <ID>
```

## Good to know ("Gut zu wissen")

- **Provider support:**
  - OpenAI models supporting `reasoning_effort` (such as `o1` and `o3-mini`).
  - Anthropic models supporting thinking budgets (such as Claude 3.7 Sonnet).
  - Gemini models supporting thinking mode (such as Gemini 2.0 Flash Thinking).
  - For models that do not support reasoning tokens, the setting is ignored without causing an error.
- **Human-only guard:** Changing a chat session's model configuration (`chat.model.set`) is restricted to human operators. Autonomous agents and WebMCP tools cannot silently alter your chat model.
- **Local-only enforcement:** If "Local only" is enabled globally or for the active agent, cloud model profiles are hidden from the dropdown and refused if requested.
- **Incognito privacy:** Incognito sessions never write cards to the memory store or conversation transcripts to disk.

## Error messages ("Fehlermeldungen")

- `E_MODEL_FORBIDDEN_LOCAL_ONLY`: The selected model profile belongs to an external cloud provider, but "Local only" mode is active.
- `E_NOT_FOUND`: The requested model profile was not found in your configuration.
- `E_FORBIDDEN`: A tool, agent, or non-human principal attempted to modify the chat session's model.

## Next

- Manage model profiles and providers: [providers.md](providers.md)
- Privacy and local-only configuration: [privacy.md](privacy.md)
- Managing long conversations: [long-conversations.md](long-conversations.md)
