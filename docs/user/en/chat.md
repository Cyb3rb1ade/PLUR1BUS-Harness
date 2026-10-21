# Chat

The Chat page (`#/chat`) is where you talk to an agent. The list on the left holds your chats, the conversation is on the right. Your chats are private: only you see them. The German version of this page is [../de/chat.md](../de/chat.md).

## Start a chat

1. Choose **New chat**.
2. Pick the **Agent**. The list shows the agents of this installation.
3. Tick **Don't remember this chat** if nothing of it may reach memory. This is set when the chat starts and cannot be changed later. Such a chat carries the badge **Not remembered**.
4. Write the **First message** and choose **Start chat**.

A chat started here belongs to no project. If no agent is available, the page says so; create one first, see [agents.md](agents.md). If no model provider is configured, the agent cannot answer: you get the hint to set one up under Models, see [providers.md](providers.md). The chat exists anyway, and the text of your first message is put back into its box.

## Write and stop

- **Enter** sends, **Shift+Enter** adds a line.
- While the agent answers, its message shows **Writing…** and **Send** turns into **Stop**. A reply that you stopped shows **Stopped**, a reply that went wrong shows **Failed** with the reason, a finished one shows **Done**.
- The conversation lists your messages, the agent's, tool output and system messages. An image that the agent produced appears in its message with a download link.
- If a message cannot be sent, your text stays in the box. Send it again.
- You can follow a reply as it is written. If the live channel is not available, the page asks for the reply every second while one is running and tells you so.

## The history

The list shows your direct chats: title (or **Untitled chat**), agent, the badge **Not remembered** where it applies, and the date of the last reply. It holds the newest 100 chats; if there are more, a note says so. Archived chats are not listed and cannot be continued. Opening one by its link shows **Chat is archived**. You archive a chat on the command line, see below.

## Model and reasoning

The chat head has two selects for the model and the reasoning level of this chat. A change applies from the next reply. How it works and what it costs is on [chat-models.md](chat-models.md).

## Promote a chat to a project

The menu **Chat actions** in the chat head has **Promote or link chat**. It is not available while a reply is being written. The chat itself stays private; only the content you choose is copied.

1. Choose the **Destination**: **Link existing project**, **Create project card** or **Create new project**. For the first two you pick the **Project**, for the last you give the **New project name** (up to 160 characters).
2. Set the **Destination card title** (default *Conversation notes*, up to 256 characters).
3. Choose the **Content to copy**: **No content** (the default), **Written summary** (you write it), **Selected messages** (you tick them) or **Full transcript**.
4. Choose **Preview selection**, read what would be copied, then choose **Confirm promotion**.

Any change after the preview asks for a new preview. The preview is held for ten minutes. System messages are never copied, and content that is too large (more than 64 KiB) is refused instead of being cut. The original chat is not changed. Chosen content ends up in a new card on the project's board; with **No content** nothing from the chat is copied. Projects that are already linked to the chat are listed in the dialog. More on boards in [projects.md](projects.md).

## On the command line

```sh
plur1bus chat --agent main "Which database is staging?"
plur1bus chat --agent main --no-memory "Draft a status mail"
plur1bus chat --session <id> "Where did we leave off?"
plur1bus session list --archived any --search staging
plur1bus session show <id> --messages 50
plur1bus session archive <id>
```

- `plur1bus chat` sends one message, or reads lines from standard input until the end. `--no-memory` is the same as the tick box above, `--session` continues a chat, `--model <profile>` picks a configured model profile for the session.
- `plur1bus session list` lists your chats. `--agent`, `--kind` (`direct`, `card`, `project`, `channel` or `acp`), `--archived` (`only` or `any`), `--search` (titles and messages) and `--limit` narrow the list.
- `plur1bus session show` prints the last messages (20 by default). `plur1bus session archive` archives a chat; nothing is deleted.

## When something goes wrong

| Message | What to do |
|---|---|
| No model provider is configured, so the agent cannot answer | Configure one, see [providers.md](providers.md). |
| The agent is still answering | Wait for the reply or choose **Stop**. |
| The harness does not know this agent | The agent was removed. Pick another one. |
| You are not allowed to do this | Your role does not allow chatting with this agent. See [users-and-roles.md](users-and-roles.md). |
| Chat is not available | This build has no chat service, or it is not reachable right now. Try again in a moment. |
| Chat not found | The chat does not exist or is not yours. |

## Next

- Chat models and reasoning: [chat-models.md](chat-models.md)
- Long conversations and summaries: [long-conversations.md](long-conversations.md)
- Managing agents: [agents.md](agents.md)
- What an agent remembers: [memories.md](memories.md)
