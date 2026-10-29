/** Source metadata and byte uploads; native selections remain opaque to the browser. */
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { t, type Key } from "../../i18n.ts";
import { PageLoading } from "../../components/page-state.ts";
import { currentRole, getApi, useLoad } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import { hostInvoke, hostSnapshot } from "./host.ts";
import type { SourceInput } from "./model.ts";
import { SshSetup } from "./ssh-setup.ts";
import type {
  AdminImportSshConnectionsListResult,
  AdminImportWslListResult,
} from "../../../../rpc-schema/generated/types.ts";

export type SourceCatalog = import("../../../../api/src/import-routes.ts").ImportSourcesResult;
export const initialSource: SourceInput = {
  family: "",
  mode: "auto",
  path: "",
  profile: "",
  distro: "",
  stopped: false,
  probeStopped: false,
  connectionId: "",
  snapshotId: "",
};
export function SourcePicker({
  catalog,
  value,
  set,
  busy,
}: {
  catalog: SourceCatalog;
  value: SourceInput;
  set(value: SourceInput): void;
  busy: boolean;
}): View {
  const activeUpload = useRef<AbortController | null>(null);
  useEffect(() => () => activeUpload.current?.abort(), []);
  const [showSshSetup, setShowSshSetup] = useState(false);
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState(""),
    [snapshot, setSnapshot] = useState<{ fileCount: number; bytes: number } | null>(null);
  const wsl = useLoad(
    (signal) =>
      value.mode === "wsl"
        ? (getApi().rpc("admin.import.wsl.list", {}, { write: false, signal }) as Promise<AdminImportWslListResult>)
        : Promise.resolve({ available: false, distros: [] }),
    [value.mode],
  );
  const ssh = useLoad(
    (signal) =>
      value.mode === "ssh"
        ? (getApi().rpc(
            "admin.import.ssh.connections.list",
            {},
            { write: false, signal },
          ) as Promise<AdminImportSshConnectionsListResult>)
        : Promise.resolve({ connections: [] }),
    [value.mode],
  );
  const patch = (next: Partial<SourceInput>): void => set({ ...value, ...next });
  const native = async (): Promise<void> => {
    if (busy || uploading) return;
    setUploading(true);
    setError("");
    try {
      const result = await hostSnapshot(value.family);
      if (result) {
        patch({ mode: "snapshot", snapshotId: result.snapshotId });
        setSnapshot(result);
      }
    } catch {
      setError(t("imports.failure"));
    } finally {
      setUploading(false);
    }
  };
  const upload = async (file: File | undefined): Promise<void> => {
    if (!file || busy || uploading) return;
    const controller = new AbortController();
    activeUpload.current = controller;
    setUploading(true);
    setError("");
    try {
      const api = getApi();
      if (!api.upload || file.size > 1073741824) throw new Error("snapshot-limit");
      const result = await api.upload<{ snapshotId: string; expiresAt: number; sha256: string }>(
        "/api/v1/import/snapshots",
        file,
        file.name,
        { signal: controller.signal },
      );
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(result.snapshotId) ||
        !/^[a-f0-9]{64}$/.test(result.sha256) ||
        result.expiresAt <= Date.now()
      )
        throw new Error("snapshot-invalid");
      patch({ mode: "snapshot", snapshotId: result.snapshotId });
      setSnapshot(null);
    } catch {
      setError(t("imports.failure"));
    } finally {
      if (activeUpload.current === controller) activeUpload.current = null;
      setUploading(false);
    }
  };
  const field = (id: string, label: string, content: View): View =>
    h("div", { class: "field" }, h("label", { for: id }, label), content);
  return h(
    "fieldset",
    { disabled: busy || uploading },
    h("legend", null, t("imports.source")),
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,
    field(
      "import-family",
      t("imports.family"),
      h(
        "select",
        {
          id: "import-family",
          value: value.family,
          onChange: (event: Event) => {
            patch({ family: (event.target as HTMLSelectElement).value, snapshotId: "" });
            setSnapshot(null);
          },
        },
        h("option", { value: "" }, t("imports.choose")),
        catalog.sources.map((source) => h("option", { key: source.id, value: source.id }, source.displayName)),
      ),
    ),
    field(
      "import-mode",
      t("imports.mode"),
      h(
        "select",
        {
          id: "import-mode",
          value: value.mode,
          onChange: (event: Event) => patch({ mode: (event.target as HTMLSelectElement).value as SourceInput["mode"] }),
        },
        (["auto", "path", "wsl", "ssh", "snapshot"] as const).map((mode) =>
          h(
            "option",
            { key: mode, value: mode, disabled: !catalog.hostPathsAllowed && ["path", "wsl"].includes(mode) },
            t(`imports.${mode}` as Key),
          ),
        ),
      ),
    ),
    !catalog.hostPathsAllowed ? h(Notice, {}, t("imports.hostDenied")) : null,
    ["path", "wsl", "ssh"].includes(value.mode)
      ? field(
          "import-source-path",
          t("imports.pathLabel"),
          h("input", {
            id: "import-source-path",
            type: "text",
            value: value.path,
            maxLength: 4096,
            autoComplete: "off",
            onInput: (event: Event) => patch({ path: (event.target as HTMLInputElement).value }),
          }),
        )
      : null,
    value.mode !== "wsl"
      ? field(
          "import-profile",
          t("imports.profile"),
          h("input", {
            id: "import-profile",
            type: "text",
            value: value.profile,
            maxLength: 256,
            onInput: (event: Event) => patch({ profile: (event.target as HTMLInputElement).value }),
          }),
        )
      : null,
    value.mode === "wsl"
      ? wsl.state.status === "loading"
        ? h(PageLoading, { label: t("state.loading") })
        : wsl.state.status === "fail"
          ? h(FailureState, { failure: wsl.state.failure, onRetry: wsl.reload })
          : !wsl.state.data.available
            ? h(Notice, {}, t("imports.wslUnavailable"))
            : h(
                "div",
                {},
                field(
                  "import-distro",
                  t("imports.distro"),
                  h(
                    "select",
                    {
                      id: "import-distro",
                      value: value.distro,
                      onChange: (event: Event) => {
                        const distro =
                          wsl.state.status === "ok"
                            ? wsl.state.data.distros.find(
                                (item) => item.name === (event.target as HTMLSelectElement).value,
                              )
                            : undefined;
                        patch({
                          distro: distro?.name ?? "",
                          stopped: distro?.state === "Stopped",
                          probeStopped: false,
                        });
                      },
                    },
                    h("option", { value: "" }, t("imports.choose")),
                    wsl.state.data.distros.map((distro) =>
                      h("option", { value: distro.name }, `${distro.name} (${distro.state}, WSL ${distro.version})`),
                    ),
                  ),
                ),
                value.stopped
                  ? h(
                      "label",
                      { class: "checkbox-label" },
                      h("input", {
                        type: "checkbox",
                        checked: value.probeStopped,
                        onChange: (event: Event) => patch({ probeStopped: (event.target as HTMLInputElement).checked }),
                      }),
                      " ",
                      t("imports.probeStopped"),
                    )
                  : null,
              )
      : null,
    value.mode === "ssh"
      ? h(
          "div",
          {},
          h("p", { class: "field-hint" }, t("imports.connectionHint")),
          ssh.state.status === "loading"
            ? h(PageLoading, { label: t("state.loading") })
            : ssh.state.status === "fail"
              ? h(FailureState, { failure: ssh.state.failure, onRetry: ssh.reload })
              : field(
                  "import-connection",
                  t("imports.connection"),
                  h(
                    "select",
                    {
                      id: "import-connection",
                      value: value.connectionId,
                      onChange: (event: Event) => patch({ connectionId: (event.target as HTMLSelectElement).value }),
                    },
                    h("option", { value: "" }, t("imports.choose")),
                    ssh.state.data.connections.map((connection) =>
                      h(
                        "option",
                        { key: connection.id, value: connection.id, disabled: !connection.hostKey },
                        `${connection.id} (${connection.user}@${connection.host})`,
                      ),
                    ),
                  ),
                ),
          currentRole() === "owner"
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn-quiet",
                  "aria-expanded": showSshSetup,
                  onClick: () => setShowSshSetup((current) => !current),
                },
                t("imports.ssh.open"),
              )
            : null,
          showSshSetup && currentRole() === "owner"
            ? h(SshSetup, { onChanged: ssh.reload, suggestion: catalog.sshHostSuggestion })
            : null,
        )
      : null,
    value.mode === "snapshot"
      ? field(
          "import-snapshot",
          t("imports.snapshotFile"),
          h("input", {
            id: "import-snapshot",
            type: "file",
            accept: ".tar.gz,.tgz",
            onChange: (event: Event) => {
              void upload((event.target as HTMLInputElement).files?.[0]);
            },
          }),
        )
      : null,
    hostInvoke()
      ? h(
          "button",
          {
            type: "button",
            class: "btn",
            disabled: !value.family,
            onClick: () => {
              void native();
            },
          },
          t("imports.nativePick"),
        )
      : null,
    snapshot
      ? h("p", { role: "status" }, t("imports.snapshotReady", { files: snapshot.fileCount, bytes: snapshot.bytes }))
      : value.snapshotId
        ? h("p", { role: "status" }, t("imports.snapshotUploaded"))
        : null,
    uploading ? h("p", { role: "status", "aria-busy": "true" }, t("state.loading")) : null,
  );
}
