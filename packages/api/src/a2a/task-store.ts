import {
  Task,
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
} from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { A2A_DEFAULT_PAGE_SIZE } from "./types.ts";

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly agentId: string;
  private readonly onSave?: ((task: Task) => void) | undefined;

  constructor(agentId: string, onSave?: (task: Task) => void) {
    this.agentId = agentId;
    this.onSave = onSave;
  }

  async save(task: Task): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
    this.onSave?.(structuredClone(task));
  }

  async load(taskId: string): Promise<Task | undefined> {
    const found = this.tasks.get(taskId);
    return found ? structuredClone(found) : undefined;
  }

  async list(params: ListTasksRequest): Promise<ListTasksResponse> {
    let all = Array.from(this.tasks.values()).map((t) => structuredClone(t));
    if (params.contextId) {
      all = all.filter((t) => t.contextId === params.contextId);
    }
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      all = all.filter((t) => t.status?.state === params.status);
    }
    return {
      tasks: all,
      totalSize: all.length,
      pageSize: params.pageSize || A2A_DEFAULT_PAGE_SIZE,
      nextPageToken: "",
    };
  }
}

export interface SqliteTaskStoreOptions {
  path?: string | undefined;
  db?: DatabaseSync | undefined;
  agentId: string;
  onSave?: ((task: Task) => void) | undefined;
}

export class SqliteTaskStore implements TaskStore {
  readonly #db: DatabaseSync;
  readonly #agentId: string;
  readonly #onSave?: ((task: Task) => void) | undefined;
  readonly #ownsDb: boolean;

  constructor(opts: SqliteTaskStoreOptions) {
    this.#agentId = opts.agentId;
    this.#onSave = opts.onSave;
    if (opts.db) {
      this.#db = opts.db;
      this.#ownsDb = false;
    } else {
      const p = opts.path ?? ":memory:";
      if (p !== ":memory:") {
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
        try { chmodSync(dirname(p), 0o700); } catch {}
        closeSync(openSync(p, "a", 0o600));
        try { chmodSync(p, 0o600); } catch {}
      }
      this.#db = new DatabaseSync(p);
      this.#ownsDb = true;
    }

    this.#db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS a2a_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        context_id TEXT,
        state INTEGER NOT NULL DEFAULT 0,
        task_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_a2a_tasks_agent ON a2a_tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks(context_id);
    `);
  }

  async save(task: Task): Promise<void> {
    const jsonStr = JSON.stringify(Task.toJSON(task));
    const now = Date.now();
    const state = typeof task.status?.state === "number" ? task.status.state : 0;
    const contextId = task.contextId || null;

    this.#db.prepare(`
      INSERT INTO a2a_tasks (id, agent_id, context_id, state, task_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        context_id = excluded.context_id,
        state = excluded.state,
        task_json = excluded.task_json,
        updated_at = excluded.updated_at
    `).run(task.id, this.#agentId, contextId, state, jsonStr, now, now);

    this.#onSave?.(structuredClone(task));
  }

  async load(taskId: string): Promise<Task | undefined> {
    const row = this.#db.prepare("SELECT task_json FROM a2a_tasks WHERE id = ? AND agent_id = ?").get(taskId, this.#agentId) as { task_json: string } | undefined;
    if (!row) return undefined;
    try {
      return Task.fromJSON(JSON.parse(row.task_json));
    } catch {
      return undefined;
    }
  }

  async list(params: ListTasksRequest): Promise<ListTasksResponse> {
    let sql = "SELECT task_json FROM a2a_tasks WHERE agent_id = ?";
    const args: Array<string | number> = [this.#agentId];

    if (params.contextId) {
      sql += " AND context_id = ?";
      args.push(params.contextId);
    }
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      sql += " AND state = ?";
      const statusNum = typeof params.status === "number"
        ? params.status
        : (TaskState[params.status as unknown as keyof typeof TaskState] ?? 0);
      args.push(statusNum);
    }

    sql += " ORDER BY created_at ASC";

    const rows = this.#db.prepare(sql).all(...args) as Array<{ task_json: string }>;
    const tasks: Task[] = [];
    for (const r of rows) {
      try {
        tasks.push(Task.fromJSON(JSON.parse(r.task_json)));
      } catch {}
    }

    const pageSize = params.pageSize || A2A_DEFAULT_PAGE_SIZE;
    return {
      tasks,
      totalSize: tasks.length,
      pageSize,
      nextPageToken: "",
    };
  }

  close(): void {
    if (this.#ownsDb) {
      try {
        this.#db.close();
      } catch {}
    }
  }
}
