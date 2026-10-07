// A2A 0.3 stream payloads (spec §7.2 / §9.3): Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent.
import type { A2aArtifactUpdateEvent, A2aStatusUpdateEvent, A2aTask, TaskState } from "./types.ts";

export const statusUpdate = (task: A2aTask, state: TaskState, final: boolean, timestamp: string): A2aStatusUpdateEvent => ({
  kind: "status-update",
  taskId: task.id,
  contextId: task.contextId,
  status: { ...task.status, state, timestamp },
  ...(final ? { final: true } : {}),
});

export const artifactUpdate = (
  task: A2aTask, artifactId: string, text: string, append: boolean, lastChunk: boolean, name = "reply",
): A2aArtifactUpdateEvent => ({
  kind: "artifact-update",
  taskId: task.id,
  contextId: task.contextId,
  artifact: { artifactId, name, parts: [{ kind: "text", text }] },
  append,
  lastChunk,
});

export async function *sseLines(id: unknown, results: AsyncIterable<unknown>): AsyncIterable<string> {
  for await (const result of results) {
    yield `data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
  }
}
