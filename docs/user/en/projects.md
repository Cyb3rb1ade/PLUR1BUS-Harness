# Projects & Board

The Projects page (`#/projects`) provides a collaborative Kanban board designed for humans and AI agents working together in Plur1bus. Each project has a dedicated board with columns, work-in-progress (WIP) limits, cards, comments, activity logs, and real-time live synchronization. The German version of this page is [../de/projekte.md](../de/projekte.md).

## At a Glance

- **Projects sidebar:** Lists all projects with live status badges showing open cards and overdue cards.
- **Kanban columns:** Visual workflow columns (such as Backlog, In Progress, Review, Done) with optional WIP limits.
- **Rich cards:** Cards display title, priority level, labels, due date status, links to sessions/jobs/media, and assignee avatars for both humans and agents.
- **Drag & drop and keyboard navigation:** Move cards between columns using drag & drop or accessible keyboard shortcuts (`ArrowLeft` / `ArrowRight` or `[` / `]`), with announcements via `aria-live`.
- **Card detail drawer:** Click any card to view its description rendered in safe Markdown without raw HTML, read comments, post new comments, inspect the activity audit trail, assign members or agents, and archive cards.
- **Column management:** Project leads, admins, and owners can add, rename, reorder, and remove columns (with safe migration of existing cards).
- **Filters:** Fast client-side filtering by text search, assignee, label, and archived status.
- **Live updates & optimistic UI:** Real-time push via `/events` SSE with optimistic card movements and immediate rollback if an action violates a WIP limit (`E_PROJECT_WIP_LIMIT`).

## Projects Sidebar

The left sidebar lists available projects. For each project, status badges indicate:
- **Open cards:** Number of active, uncompleted cards in the project.
- **Due cards:** Number of cards whose due date is in the past.

Owners and administrators can create new projects directly from the sidebar by choosing **New project**.

## Kanban Columns & WIP Limits

Each column represents a workflow stage. Columns can define a **WIP limit** (maximum number of concurrent cards allowed).

- When the number of active cards reaches or exceeds the WIP limit, the column badge turns into an error state warning operators.
- Moving or creating a card in a column that has reached its WIP limit is prevented by the backend with an `E_PROJECT_WIP_LIMIT` error. The UI displays an explanatory notification and automatically rolls back any optimistic card movement.

Columns can be added, reordered, edited, or deleted via **Manage columns** by project leads, administrators, and owners. When deleting a column, cards can be migrated to another target column.

## Cards

Each card captures a work item:
- **Title and Description:** Plain title and rich Markdown description supporting lists, code snippets, blockquotes, bold, italics, and safe URLs (HTML tags and javascript links are blocked).
- **Priority:** None, Low, Normal, High, or Urgent.
- **Assignees:** Human team members and AI agents. Agents are distinguished with a specialized agent robot icon. Agents may only move cards assigned to them.
- **Due Date:** Due date indicators display warning icons for overdue cards.
- **Links:** Quick references to related sessions, jobs, media assets, or external URLs.

## Moving Cards (Mouse & Accessibility)

Cards can be moved in two ways:
1. **Mouse / Pointer:** Drag any card and drop it onto the target column.
2. **Keyboard Navigation:** Tab to focus a card (`tabindex="0"`), then use:
   - `ArrowLeft` or `[`: Move card to the preceding column.
   - `ArrowRight` or `]`: Move card to the subsequent column.
   - `ArrowUp` / `ArrowDown`: Move card up or down within the current column.
   - `Enter` or `Space`: Open the card detail drawer.

Every keyboard movement is announced immediately to assistive technology via a polite ARIA live region (`aria-live="polite"`).

## Card Detail Drawer

Clicking a card opens the slide-over detail drawer:
- **Description:** Formatted safely using an HTML-free AST renderer.
- **Assignees:** Assign or remove project members and AI agents.
- **Comments:** Discussion thread for human operators and agents. Type a comment and press **Add comment**.
- **Activity Log:** Chronological timeline tracking creation, column moves, assignment updates, comments, and archive events.
- **Archive / Unarchive:** Completed or superseded cards can be archived to keep the board clean while preserving full history.

## Filters

The filter bar at the top of the board allows refining visible cards:
- **Text Search:** Matches against card titles and descriptions.
- **Assignee:** Filter to cards assigned to a specific person or agent.
- **Label:** Filter by card label.
- **Show Archived:** Toggle viewing archived cards alongside active cards.
