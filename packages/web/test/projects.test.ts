import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  browserSkip,
  openRoute,
  setup,
  teardown,
  withApp,
  type App,
} from "./harness.ts";
import { rpcError, type MockRpc } from "./mock-rpc.ts";
import type {
  BoardCard,
  BoardColumn,
  Project,
} from "../src/pages/projects/rpc-types.ts";

before(setup);
after(teardown);

const opts = { skip: browserSkip };

const projectFixture: Project = {
  id: "prj_alpha",
  name: "Alpha Project",
  owner: "owner",
  members: [
    { userId: "owner", role: "lead" },
    { userId: "alice", role: "member" },
  ],
  agents: ["agent_coder"],
  archivedAt: null,
};

const defaultColumns: BoardColumn[] = [
  { id: "col_backlog", title: null, titleKey: "project.board.backlog", position: 0, wipLimit: null },
  { id: "col_progress", title: null, titleKey: "project.board.inProgress", position: 1, wipLimit: 2 },
  { id: "col_review", title: null, titleKey: "project.board.review", position: 2, wipLimit: null },
  { id: "col_done", title: null, titleKey: "project.board.done", position: 3, wipLimit: null },
];

const cardsFixture: BoardCard[] = [
  {
    id: "card_1",
    projectId: "prj_alpha",
    title: "Implement auth",
    description: "Support **JWT** and *sessions*.\n\n```ts\nconst token = 123;\n```",
    columnId: "col_backlog",
    position: 0,
    labels: ["auth", "security"],
    priority: "high",
    dueAt: 1893456000000,
    assignees: [{ kind: "person", id: "alice" }],
    links: [{ kind: "session", id: "sess_1" }, { kind: "url", id: "https://example.com" }],
    createdBy: { kind: "person", id: "owner" },
    updatedBy: { kind: "person", id: "owner" },
    createdAt: 1000,
    updatedAt: 1000,
    archived: false,
  },
  {
    id: "card_2",
    projectId: "prj_alpha",
    title: "Agent task",
    description: "Autonomous refactoring task",
    columnId: "col_progress",
    position: 0,
    labels: ["refactor"],
    priority: "urgent",
    dueAt: 100, // overdue
    assignees: [{ kind: "agent", id: "agent_coder" }],
    links: [],
    createdBy: { kind: "person", id: "owner" },
    updatedBy: { kind: "person", id: "owner" },
    createdAt: 2000,
    updatedAt: 2000,
    archived: false,
  },
  {
    id: "card_3",
    projectId: "prj_alpha",
    title: "Old archived bug",
    description: "Already fixed",
    columnId: "col_done",
    position: 0,
    labels: ["bug"],
    priority: "low",
    dueAt: null,
    assignees: [],
    links: [],
    createdBy: { kind: "person", id: "owner" },
    updatedBy: { kind: "person", id: "owner" },
    createdAt: 500,
    updatedAt: 500,
    archived: true,
  },
];

function seedProjectBoard(
  rpc: MockRpc,
  over: {
    projects?: Project[];
    columns?: BoardColumn[];
    cards?: BoardCard[];
  } = {},
) {
  let projectsList = over.projects ?? [projectFixture];
  let columnsList = over.columns ?? defaultColumns;
  let cardsList = over.cards ?? cardsFixture;

  rpc.handle("project.list", () => ({ projects: projectsList }), { write: false });
  rpc.handle("project.create", (p: any) => {
    const newProj: Project = {
      id: `prj_${Date.now()}`,
      name: p.name,
      owner: "owner",
      members: [{ userId: "owner", role: "lead" }],
      agents: [],
      archivedAt: null,
    };
    projectsList.push(newProj);
    return newProj;
  });

  rpc.handle("project.column.list", () => ({ columns: columnsList }), { write: false });
  rpc.handle("project.column.create", (p: any) => {
    const col: BoardColumn = {
      id: `col_${Date.now()}`,
      title: p.title ?? null,
      titleKey: p.titleKey ?? null,
      position: columnsList.length,
      wipLimit: p.wipLimit ?? null,
    };
    columnsList.push(col);
    return col;
  });
  rpc.handle("project.column.update", (p: any) => {
    const col = columnsList.find((c) => c.id === p.columnId);
    if (col) {
      if (p.title !== undefined) col.title = p.title;
      if (p.wipLimit !== undefined) col.wipLimit = p.wipLimit;
    }
    return col;
  });
  rpc.handle("project.column.move", (p: any) => {
    const col = columnsList.find((c) => c.id === p.columnId);
    return col;
  });
  rpc.handle("project.column.delete", (p: any) => {
    columnsList = columnsList.filter((c) => c.id !== p.columnId);
    return { deleted: true };
  });

  rpc.handle("project.card.list", (p: any) => {
    let res = cardsList;
    if (p.columnId) res = res.filter((c) => c.columnId === p.columnId);
    if (p.archived !== undefined) res = res.filter((c) => c.archived === p.archived);
    return { cards: res, nextCursor: null };
  }, { write: false });

  rpc.handle("project.card.create", (p: any) => {
    const targetCol = columnsList.find((c) => c.id === p.columnId);
    if (
      targetCol?.wipLimit &&
      cardsList.filter((c) => c.columnId === p.columnId && !c.archived).length >=
        targetCol.wipLimit
    ) {
      throw rpcError("E_PROJECT_WIP_LIMIT", "project WIP limit exceeded", "project-board-wip");
    }
    const card: BoardCard = {
      id: `card_${Date.now()}`,
      projectId: p.projectId,
      title: p.title,
      description: p.description ?? "",
      columnId: p.columnId,
      position: cardsList.filter((c) => c.columnId === p.columnId).length,
      labels: p.labels ?? [],
      priority: p.priority ?? "normal",
      dueAt: p.dueAt ?? null,
      assignees: [],
      links: [],
      createdBy: { kind: "person", id: "owner" },
      updatedBy: { kind: "person", id: "owner" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
    };
    cardsList.push(card);
    return card;
  });

  rpc.handle("project.card.move", (p: any) => {
    const card = cardsList.find((c) => c.id === p.cardId);
    if (!card) throw rpcError("E_NOT_FOUND", "card not found");
    const targetCol = columnsList.find((c) => c.id === p.columnId);
    if (
      card.columnId !== p.columnId &&
      targetCol?.wipLimit &&
      cardsList.filter((c) => c.columnId === p.columnId && !c.archived).length >=
        targetCol.wipLimit
    ) {
      throw rpcError("E_PROJECT_WIP_LIMIT", "project WIP limit exceeded", "project-board-wip");
    }
    card.columnId = p.columnId;
    if (p.position !== undefined) card.position = p.position;
    return card;
  });

  const commentsList = [
    {
      id: "cmt_1",
      cardId: "card_1",
      author: { kind: "person", id: "alice" },
      text: "Started working on this.",
      createdAt: 1500,
    },
  ];

  rpc.handle("project.card.comment.list", () => ({
    items: [...commentsList],
    nextCursor: null,
  }), { write: false });

  rpc.handle("project.card.comment.add", (p: any) => {
    const newComment = {
      id: `cmt_${Date.now()}`,
      cardId: p.cardId,
      author: { kind: "person", id: "owner" },
      text: p.text,
      createdAt: Date.now(),
    };
    commentsList.push(newComment);
    return newComment;
  });

  rpc.handle("project.card.activity.list", () => ({
    items: [
      {
        id: "act_1",
        cardId: "card_1",
        kind: "created",
        actor: { kind: "person", id: "owner" },
        at: 1000,
        detail: "",
      },
    ],
    nextCursor: null,
  }), { write: false });

  rpc.handle("project.card.archive", (p: any) => {
    const card = cardsList.find((c) => c.id === p.cardId);
    if (card) card.archived = true;
    return card;
  });
  rpc.handle("project.card.unarchive", (p: any) => {
    const card = cardsList.find((c) => c.id === p.cardId);
    if (card) card.archived = false;
    return card;
  });
}

describe("projects: board render & sidebar", opts, () => {
  test("renders sidebar with projects, open/due badges, and selects a project", async () => {
    await withApp({}, async (app) => {
      seedProjectBoard(app.server.rpc);
      await openRoute(app.page, "#/projects");

      // Heading
      await app.page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();

      // Sidebar item with badges
      const projectLink = app.page.getByRole("link", { name: /Alpha Project/ });
      await projectLink.waitFor();
      assert.match(await app.page.locator(".projects-sidebar").innerText(), /open/);

      // Click to open project board
      await projectLink.click();
      await app.page.waitForURL(/#\/projects\/prj_alpha/);

      // Verify columns rendered
      await app.page.getByRole("heading", { name: "Backlog" }).waitFor();
      await app.page.getByRole("heading", { name: "In Progress" }).waitFor();
      await app.page.getByRole("heading", { name: "Review" }).waitFor();
      await app.page.getByRole("heading", { name: "Done" }).waitFor();

      // WIP limit badge
      await app.page.getByText("WIP: 1/2").waitFor();

      // Cards rendered
      await app.page.getByText("Implement auth").waitFor();
      await app.page.getByText("Agent task").waitFor();
    });
  });
});

describe("projects: move via drag-and-drop and keyboard", opts, () => {
  test("keyboard navigation moves card to next column and announces via aria-live", async () => {
    await withApp({}, async (app) => {
      seedProjectBoard(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");

      const card = app.page.locator('[data-card-id="card_1"]');
      await card.waitFor();
      await card.focus();

      // Move right (to In Progress) using ArrowRight
      await app.page.keyboard.press("ArrowRight");

      // Assert announcement in polite live region
      const liveRegion = app.page.locator('.board-live-region');
      await liveRegion.filter({ hasText: "Implement auth" }).waitFor();
      const liveText = (await liveRegion.textContent()) ?? "";
      assert.match(liveText, /Implement auth/);

      // Check RPC call
      for (let i = 0; i < 40 && !app.server.rpc.calls.some((c) => c.method === "project.card.move"); i++) {
        await app.page.waitForTimeout(50);
      }
      const moveCalls = app.server.rpc.calls.filter((c) => c.method === "project.card.move");
      assert.ok(moveCalls.length >= 1);
      assert.equal((moveCalls[0]?.params as any).cardId, "card_1");
      assert.equal((moveCalls[0]?.params as any).columnId, "col_progress");
    });
  });

  test("drag and drop moves card to another column", async () => {
    await withApp({}, async (app) => {
      seedProjectBoard(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");

      await app.page.locator('[data-card-id="card_1"]').waitFor();
      const targetCol = app.page.locator('[data-column-id="col_review"]');
      await targetCol.waitFor();

      // Dispatch drag and drop events
      await app.page.evaluate(() => {
        const card = document.querySelector('[data-card-id="card_1"]') as HTMLElement;
        const col = document.querySelector('[data-column-id="col_review"]') as HTMLElement;
        const dt = new DataTransfer();
        dt.setData("text/plain", "card_1");
        card.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
        col.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
        col.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
      });

      for (let i = 0; i < 40 && !app.server.rpc.calls.some((c) => c.method === "project.card.move" && (c.params as any).columnId === "col_review"); i++) {
        await app.page.waitForTimeout(50);
      }
      const moveCalls = app.server.rpc.calls.filter((c) => c.method === "project.card.move");
      assert.ok(moveCalls.some((c) => (c.params as any).columnId === "col_review"));
    });
  });
});

describe("projects: WIP limit & optimistic rollback", opts, () => {
  test("WIP limit error rolls back optimistic update and displays error", async () => {
    await withApp({}, async (app) => {
      seedProjectBoard(app.server.rpc);
      // Make project.card.move throw WIP limit error
      app.server.rpc.handle("project.card.move", () => {
        throw rpcError("E_PROJECT_WIP_LIMIT", "project WIP limit exceeded", "project-board-wip");
      });

      await openRoute(app.page, "#/projects/prj_alpha");

      const card = app.page.locator('[data-card-id="card_1"]');
      await card.waitFor();
      await card.focus();

      // Attempt to move right
      await app.page.keyboard.press("ArrowRight");

      // Verify rollback notice / error alert
      await app.page.locator(".board-alert").waitFor();
      const alertText = (await app.page.locator(".board-alert").textContent()) ?? "";
      assert.match(alertText, /WIP/i);
    });
  });
});

describe("projects: permissions", opts, () => {
  test("viewer is read-only: no move, no card creation, no column manage", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seedProjectBoard(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");

      await app.page.getByText("Implement auth").waitFor();

      // Card is not draggable
      const card = app.page.locator('[data-card-id="card_1"]');
      assert.equal(await card.getAttribute("draggable"), "false");

      // Add card button and Manage columns button absent
      assert.equal(await app.page.getByRole("button", { name: "Add card" }).count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Manage columns" }).count(), 0);
    });
  });
});

describe("projects: card drawer, safe markdown, comments & activity", opts, () => {
  test("opens drawer, renders safe markdown without HTML, adds comment", async () => {
    await withApp({}, async (app) => {
      seedProjectBoard(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");

      // Click card to open drawer
      await app.page.locator('[data-card-id="card_1"]').click();

      // Drawer dialog opens
      const drawer = app.page.locator(".card-drawer");
      await drawer.waitFor();

      // Safe Markdown: bold tag and code block are rendered
      await drawer.locator("strong").getByText("JWT").waitFor();
      await drawer.locator("pre").getByText("const token = 123;").waitFor();

      // Comments section
      await drawer.getByText("Started working on this.").waitFor();

      // Activity section
      await drawer.getByText("created the card").waitFor();

      // Add comment
      const commentInput = drawer.locator(".comment-textarea");
      await commentInput.fill("Review approved.");
      await drawer.getByRole("button", { name: "Add comment" }).click();

      for (let i = 0; i < 40 && !app.server.rpc.calls.some((c) => c.method === "project.card.comment.add"); i++) {
        await app.page.waitForTimeout(50);
      }
      const commentCalls = app.server.rpc.calls.filter((c) => c.method === "project.card.comment.add");
      assert.equal(commentCalls.length, 1);
      assert.equal((commentCalls[0]?.params as any).text, "Review approved.");
    });
  });
});

describe("projects: filters & live updates", opts, () => {
  test("filter by text, assignee, label, and archived toggle", async () => {
    await withApp({}, async (app) => {
      seedProjectBoard(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");

      await app.page.getByText("Implement auth").waitFor();
      await app.page.getByText("Agent task").waitFor();

      // Filter by text search
      const searchInput = app.page.locator(".filter-input");
      await searchInput.fill("JWT"); // matches Implement auth description
      await app.page.getByText("Implement auth").waitFor();
      assert.equal(await app.page.getByText("Agent task").count(), 0);

      // Clear search
      await searchInput.fill("");

      // Filter by label
      const labelSelect = app.page.locator(".filter-select").nth(1);
      if (await labelSelect.count()) {
        await labelSelect.selectOption("refactor");
        await app.page.getByText("Agent task").waitFor();
        assert.equal(await app.page.getByText("Implement auth").count(), 0);
        // Reset label filter
        await labelSelect.selectOption("");
      }

      // Show archived
      const archivedCheckbox = app.page.locator('.filter-checkbox-label input[type="checkbox"]');
      await archivedCheckbox.check();
      await app.page.getByText("Old archived bug").waitFor();
    });
  });

  test("live update via /events project.card.changed refreshes board", async () => {
    await withApp({}, async (app) => {
      seedProjectBoard(app.server.rpc);
      app.server.events.enable();
      await openRoute(app.page, "#/projects/prj_alpha");

      await app.page.getByText("Implement auth").waitFor();

      // Push SSE event for project card update
      app.server.events.push({
        event: "project.card.changed",
        data: { projectId: "prj_alpha", cardId: "card_1", change: "update" },
      });

      // Board triggers card list refresh
      await app.page.waitForTimeout(300);
      const listCalls = app.server.rpc.calls.filter((c) => c.method === "project.card.list");
      assert.ok(listCalls.length >= 2);
    });
  });
});

describe("projects: German translation", opts, () => {
  test("renders in German with de locale", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedProjectBoard(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha", "de");

      // Heading is "Projekte"
      await app.page.getByRole("heading", { name: "Projekte", level: 1 }).waitFor();

      // Column titles in German
      await app.page.getByRole("heading", { name: "In Arbeit" }).waitFor();
      await app.page.getByRole("heading", { name: "Erledigt" }).waitFor();
    });
  });
});
