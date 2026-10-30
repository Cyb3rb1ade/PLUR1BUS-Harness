import {
  Task,
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
export type { TaskStore };
import { TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { A2A_DEFAULT_PAGE_SIZE, A2A_MAX_TASKS_PER_OWNER } from "./types.ts";

function resolveOwner(context?: ServerCallContext): string {
  return context?.user?.userName ?? "";
}

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly taskOwners = new Map<string, string>();
  private readonly agentId: string;
  private readonly onSave?: ((task: Task) => void) | undefined;
  private readonly maxTasksPerOwner: number;

  constructor(agentId: string, onSave?: (task: Task) => void, maxTasksPerOwner = A2A_MAX_TASKS_PER_OWNER) {
    this.agentId = agentId;
    this.onSave = onSave;
    this.maxTasksPerOwner = maxTasksPerOwner;
  }

  async save(task: Task, context?: ServerCallContext): Promise<void> {
    const callerOwner = resolveOwner(context) || ((task.metadata?.owner as string | undefined) ?? "");
    const existingOwner = this.taskOwners.get(task.id);
    if (existingOwner !== undefined && callerOwner !== "" && existingOwner !== callerOwner) {
      throw new TaskNotFoundError(`Task not found: ${task.id}`);
    }
    const effectiveOwner = existingOwner ?? callerOwner;
    if (!this.tasks.has(task.id) && effectiveOwner !== "") {
      let count = 0;
      for (const o of this.taskOwners.values()) {
        if (o === effectiveOwner) count++;
      }
      if (count >= this.maxTasksPerOwner) {
        throw new UnsupportedOperationError(`Task quota exceeded for owner (${count}/${this.maxTasksPerOwner})`);
      }
    }
    if (effectiveOwner !== "") {
      this.taskOwners.set(task.id, effectiveOwner);
      task.metadata = { ...(task.metadata ?? {}), owner: effectiveOwner };
    }
    this.tasks.set(task.id, structuredClone(task));
    this.onSave?.(structuredClone(task));
  }

  async load(taskId: string, context?: ServerCallContext): Promise<Task | undefined> {
    const found = this.tasks.get(taskId);
    if (!found) return undefined;
    const callerOwner = resolveOwner(context);
    const taskOwner = this.taskOwners.get(taskId);
    if (callerOwner && taskOwner && taskOwner !== callerOwner) {
      return undefined;
    }
    return structuredClone(found);
  }

  async list(params: ListTasksRequest, context?: ServerCallContext): Promise<ListTasksResponse> {
    const callerOwner = resolveOwner(context);
    let all = Array.from(this.tasks.values());
    if (callerOwner) {
      all = all.filter((t) => this.taskOwners.get(t.id) === callerOwner);
    }
    if (params.contextId) {
      all = all.filter((t) => t.contextId === params.contextId);
    }
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      all = all.filter((t) => t.status?.state === params.status);
    }
    return {
      tasks: all.map((t) => structuredClone(t)),
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
  maxTasksPerOwner?: number | undefined;
}

export class SqliteTaskStore implements TaskStore {
  readonly #db: DatabaseSync;
  readonly #agentId: string;
  readonly #onSave?: ((task: Task) => void) | undefined;
  readonly #ownsDb: boolean;
  readonly #maxTasksPerOwner: number;

  constructor(opts: SqliteTaskStoreOptions) {
    this.#agentId = opts.agentId;
    this.#onSave = opts.onSave;
    this.#maxTasksPerOwner = opts.maxTasksPerOwner ?? A2A_MAX_TASKS_PER_OWNER;
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
        owner TEXT NOT NULL DEFAULT '',
        context_id TEXT,
        state INTEGER NOT NULL DEFAULT 0,
        task_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_a2a_tasks_agent ON a2a_tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_a2a_tasks_owner ON a2a_tasks(agent_id, owner);
      CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks(context_id);
    `);

    try {
      this.#db.exec("ALTER TABLE a2a_tasks ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
    } catch {
      // Column already exists
    }
  }

  async save(task: Task, context?: ServerCallContext): Promise<void> {
    const callerOwner = resolveOwner(context) || ((task.metadata?.owner as string | undefined) ?? "");
    const existing = this.#db.prepare("SELECT owner FROM a2a_tasks WHERE id = ? AND agent_id = ?").get(task.id, this.#agentId) as { owner: string } | undefined;
    if (existing !== undefined && callerOwner !== "" && existing.owner !== "" && existing.owner !== callerOwner) {
      throw new TaskNotFoundError(`Task not found: ${task.id}`);
    }
    const effectiveOwner = existing?.owner || callerOwner;
    if (existing === undefined && effectiveOwner !== "") {
      const countRow = this.#db.prepare("SELECT COUNT(*) as count FROM a2a_tasks WHERE agent_id = ? AND owner = ?").get(this.#agentId, effectiveOwner) as { count: number } | undefined;
      if ((countRow?.count ?? 0) >= this.#maxTasksPerOwner) {
        throw new UnsupportedOperationError(`Task quota exceeded for owner (${countRow?.count}/${this.#maxTasksPerOwner})`);
      }
    }
    if (effectiveOwner !== "") {
      task.metadata = { ...(task.metadata ?? {}), owner: effectiveOwner };
    }

    const jsonStr = JSON.stringify(Task.toJSON(task));
    const now = Date.now();
    const state = typeof task.status?.state === "number" ? task.status.state : 0;
    const contextId = task.contextId || null;

    this.#db.prepare(`
      INSERT INTO a2a_tasks (id, agent_id, owner, context_id, state, task_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        context_id = excluded.context_id,
        state = excluded.state,
        task_json = excluded.task_json,
        updated_at = excluded.updated_at
    `).run(task.id, this.#agentId, effectiveOwner, contextId, state, jsonStr, now, now);

    this.#onSave?.(structuredClone(task));
  }

  async load(taskId: string, context?: ServerCallContext): Promise<Task | undefined> {
    const callerOwner = resolveOwner(context);
    const row = this.#db.prepare("SELECT task_json, owner FROM a2a_tasks WHERE id = ? AND agent_id = ?").get(taskId, this.#agentId) as { task_json: string; owner: string } | undefined;
    if (!row) return undefined;
    if (callerOwner && row.owner && row.owner !== callerOwner) {
      return undefined;
    }
    try {
      return Task.fromJSON(JSON.parse(row.task_json));
    } catch {
      return undefined;
    }
  }

  async list(params: ListTasksRequest, context?: ServerCallContext): Promise<ListTasksResponse> {
    const callerOwner = resolveOwner(context);
    let sql = "SELECT task_json FROM a2a_tasks WHERE agent_id = ?";
    const args: Array<string | number> = [this.#agentId];

    if (callerOwner) {
      sql += " AND owner = ?";
      args.push(callerOwner);
    }
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
