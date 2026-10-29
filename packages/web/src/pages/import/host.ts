/** This adapter exposes only the two capability-gated native source commands. It never receives paths or source bytes. */
export type HostInvoke = (
  command: "host_file_pick" | "host_import_snapshot",
  args: { request: object },
) => Promise<unknown>;
export interface SnapshotMetadata {
  snapshotId: string;
  expiresAt: number;
  sha256: string;
  fileCount: number;
  bytes: number;
  label: string;
}
export function hostInvoke(): HostInvoke | undefined {
  const port = (globalThis as { __TAURI_INTERNALS__?: { invoke?: HostInvoke } }).__TAURI_INTERNALS__;
  return typeof port?.invoke === "function" ? port.invoke.bind(port) : undefined;
}
export async function hostSnapshot(
  sourceType: string,
  invoke: HostInvoke | undefined = hostInvoke(),
): Promise<SnapshotMetadata | null> {
  if (!invoke || !/^[a-z][a-z0-9-]{0,63}$/.test(sourceType)) throw new Error("native-source-unavailable");
  const picked = await invoke("host_file_pick", { request: {} });
  if (picked === null) return null;
  const selection = picked as { selectionId?: unknown; label?: unknown };
  if (
    !selection ||
    typeof selection.selectionId !== "string" ||
    !selection.selectionId ||
    selection.selectionId.length > 128 ||
    typeof selection.label !== "string" ||
    selection.label.length > 512
  )
    throw new Error("native-source-invalid");
  const result = (await invoke("host_import_snapshot", {
    request: { selectionId: selection.selectionId, sourceType },
  })) as Record<string, unknown> | null;
  if (
    !result ||
    typeof result.snapshotId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.snapshotId) ||
    typeof result.expiresAt !== "number" ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= Date.now() ||
    typeof result.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.sha256) ||
    !Number.isSafeInteger(result.fileCount) ||
    (result.fileCount as number) < 0 ||
    (result.fileCount as number) > 10000 ||
    !Number.isSafeInteger(result.bytes) ||
    (result.bytes as number) < 0 ||
    (result.bytes as number) > 536870912
  )
    throw new Error("native-source-invalid");
  return {
    snapshotId: result.snapshotId,
    expiresAt: result.expiresAt,
    sha256: result.sha256,
    fileCount: result.fileCount as number,
    bytes: result.bytes as number,
    label: selection.label,
  };
}
