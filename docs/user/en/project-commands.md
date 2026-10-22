# Project commands

`plur1bus project` manages projects, their members and agents, and the Kanban board of each project from a terminal. It does the same as the Projects page (`#/projects`), which is described in [projects.md](projects.md). The German version of this page is [../de/projekt-befehle.md](../de/projekt-befehle.md). The wire details of the board are in [../../projects-board.md](../../projects-board.md).

All 21 commands talk to the running core, so the daemon must be up. If it is not, they stop with `E_CORE_UNAVAILABLE`; start it with `plur1bus daemon start`. Every command is marked experimental in `plur1bus project --help`.

## Output and IDs

- Without `--json`, a command prints the result as indented JSON. Only `plur1bus project board` prints plain text.
- With `--json`, the result is one JSON document with a `schema` field such as `project.card.move/1`. `--json` works before or after the command.
- Projects, cards and columns are named by opaque IDs. Get them from `plur1bus project list`, `plur1bus project column list` and `plur1bus project card list`.
- Positions are zero-based. A position past the last one puts the card at the end.

## Who may do what

The core decides, not the command. The CLI acts as the signed-in person, and the project role is read from the stored membership, never from the command line.

| What | Allowed |
|---|---|
| Create a project | Owner and Admin |
| Read a board, list and show cards | Every member of the project, including Viewer; Owner and Admin |
| Create, assign and archive cards, add or remove project agents | Project members (member or lead) whose account role is Member or Operator; Owner and Admin |
| Comment and move cards | The same people; a project agent may also comment, and may move only cards assigned to it |
| Archive a project, change members and roles, manage columns, override a WIP limit | Project leads; Owner and Admin |

Viewer is always read-only. A Member, Operator or Viewer who does not belong to the project cannot read its board. An agent never uses management rights or `--override-wip`. A refusal is `E_DENIED`; an unknown project, card or column is `E_NOT_FOUND`.

## Projects

| Command | What it does |
|---|---|
| `plur1bus project create <name>` | Creates a project and makes you its lead. The name is trimmed and has 1 to 256 characters. The project starts with a board of four columns: backlog, in progress, review and done. |
| `plur1bus project list` | Lists the projects you can see. Owner, Admin and Operator see all of them; others see the projects they belong to. |
| `plur1bus project show <id>` | Shows one project with its members and agents. |
| `plur1bus project archive <id>` | Marks a project as archived. |
| `plur1bus project board <project>` | Prints the board as text: each column as `name [id]`, with its active cards below as `id  title`. Default columns show their key (for example `project.board.backlog`) instead of a translated title. With `--json` it returns `project.board/1` with the cards nested in their columns. |

## Members and agents

| Command | What it does |
|---|---|
| `plur1bus project member add <project> <user> --role lead` | Adds a person. `--role` is `member` (the default) or `lead`. Adding a person who is already a member changes the role. |
| `plur1bus project member role <project> <user> <role>` | Changes a role to `member` or `lead`. A person who is not a member gives `E_NOT_FOUND`. |
| `plur1bus project member remove <project> <user>` | Removes a person. Their access to the board ends at once. |
| `plur1bus project agent add <project> <agent>` | Assigns an agent to the project. The agent must exist (`E_AGENT_UNKNOWN` otherwise) and you need the Use right on it. |
| `plur1bus project agent remove <project> <agent>` | Removes the agent from the project. |

The person who created a project is its owner and always stays lead: lowering the owner to `member` is refused with `E_CONFLICT`.

## Cards

| Command | What it does |
|---|---|
| `plur1bus project card list <project>` | Lists cards, ordered by column and position. |
| `plur1bus project card show <project> <card>` | Shows one card. |
| `plur1bus project card create <project> <column> <title>` | Creates a card in a column. |
| `plur1bus project card move <project> <card> <column> <position>` | Moves a card to a column and position. |
| `plur1bus project card assign <project> <card> <kind> <assignee>` | Assigns a person or an agent. `<kind>` is `person` or `agent`. |
| `plur1bus project card comment <project> <card> <text>` | Adds a Markdown comment. |
| `plur1bus project card archive <project> <card>` | Archives a card; `--undo` brings it back. |

Options of `card list`:

- `--column <id>`, `--label <label>` and `--text <text>` filter by column, label and a literal, case-insensitive text.
- `--assignee <id>` filters by assignee; `--assignee-kind person|agent` says what the ID is (default `person`).
- `--archived` lists archived cards instead of active ones.
- `--limit <n>` is 1 to 100 (default 50). When more cards match, the result has a `nextCursor`; pass it as `--cursor <cursor>` for the next page. If a matching card changes in between, the cursor is refused with `E_INVALID_PARAMS`: start again from the first page.

Options of `card create`:

- `--description <text>` is plain Markdown text (empty by default).
- `--label <label>` can be repeated.
- `--priority` is `none`, `low`, `normal` (the default), `high` or `urgent`.
- `--due-at <ms>` is the due date as epoch milliseconds.
- `--position <n>` inserts at that position instead of appending.
- `--override-wip` creates the card although the column is full. It needs project lead rights.

`card move` takes the same `--override-wip`. `card assign --remove` unassigns instead. Only current project members and assigned project agents can be assigned. `card archive --undo --override-wip` unarchives into a full column; `--override-wip` is accepted only together with `--undo`.

## Columns

| Command | What it does |
|---|---|
| `plur1bus project column list <project>` | Lists the columns in order. |
| `plur1bus project column create <project> <title>` | Adds a column. `--wip-limit <n>` sets a limit of 1 or more cards, `--position <n>` places it. With `--title-key` the title is read as a translation key instead of a display title. |
| `plur1bus project column move <project> <column> <position>` | Moves a column to a position. |
| `plur1bus project column delete <project> <column>` | Deletes a column. Without `--target <column>` it must be empty; archived cards count. With `--target`, all its cards move there first. `--override-wip` allows the move into a full column. |

Moving a card between columns, creating a card, unarchiving and moving cards out of a deleted column check the WIP limit of the target. A card that would exceed it is refused with `E_PROJECT_WIP_LIMIT` and nothing changes. Reordering inside one column is always possible. Only active cards count towards the limit.

## Example

```sh
plur1bus project create "Website relaunch"
plur1bus project column list <project>
plur1bus project card create <project> <column> "Write copy" --priority high --label content
plur1bus project card assign <project> <card> agent <agent>
plur1bus project card move <project> <card> <column> 0
plur1bus project board <project>
```

## Next

- The board in the web interface: [projects.md](projects.md)
- Errors: [../../errors.md](../../errors.md)
