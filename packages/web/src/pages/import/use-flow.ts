/** Import interaction state; stores only public run IDs and never source paths or credential values. */
import { useEffect, useRef, useState } from "preact/hooks";
import { sessionState } from "../../session.ts";
import { currentRole, failureOf, getApi, useLoad, type Failure } from "../common/load.ts";
import {
  applyRequest,
  sourceDetectionRequest,
  terminalRun,
  importProgress,
  importAbortResult,
  type SourceInput,
} from "./model.ts";
import { initialSource, type SourceCatalog } from "./source-picker.ts";
import { importMappingsReady, sourceStoreReady, type DiscoveredStore } from "./store-mappings.ts";
import type {
  AdminImportDetectResult,
  ImportDetection,
  ImportDiscovery,
  ImportSource,
  AdminImportPlanParams,
  AdminImportPlanResult,
  AdminImportPreflightResult,
  AdminImportSkillsResult,
  ImportRun,
} from "../../../../rpc-schema/generated/types.ts";

/** Calls only a declared human RPC; transport handles CSRF and the authenticated cookie. */
export const importCall = <T>(method: string, params: object, write = true): Promise<T> =>
  getApi().rpc(method, params, { write }) as Promise<T>;
const call = importCall;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Owns source preview, explicit mutation actions, run polling and person-bound metadata resumption. */
export function useImportFlow() {
  const catalog = useLoad((signal) => getApi().get<SourceCatalog>("/api/v1/import/sources", { signal }), []);
  const [source, setSource] = useState<SourceInput>(initialSource),
    [detected, setDetected] = useState<ImportDetection | null>(null);
  const [discovery, setDiscovery] = useState<ImportDiscovery | null>(null);
  const [discoveredStores, setDiscoveredStores] = useState<DiscoveredStore[]>([]);
  const [agents, setAgents] = useState<string[]>([]),
    [options, setOptions] = useState<NonNullable<AdminImportPlanParams["options"]>>({
      onConflict: "skip",
      migrateSecrets: false,
      mergeProfiles: false,
    });
  const [plan, setPlan] = useState<AdminImportPlanResult | null>(null),
    [preflight, setPreflight] = useState<AdminImportPreflightResult | null>(null);
  const [preflightOperation, setPreflightOperation] = useState<"apply" | "rollback">("apply");
  const [conflicts, setConflicts] = useState<Record<string, "skip" | "rename" | "replace">>({}),
    [accepted, setAccepted] = useState(false);
  const [run, setRun] = useState<ImportRun | null>(null),
    [runId, setRunId] = useState(""),
    [history, setHistory] = useState<ImportRun[] | null>(null);
  const [skills, setSkills] = useState<AdminImportSkillsResult | null>(null),
    [skillsAccepted, setSkillsAccepted] = useState(false),
    [skillsEnable, setSkillsEnable] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Failure | null>(null),
    [aborting, setAborting] = useState(false);
  const inFlight = useRef(false),
    polling = useRef(false),
    owner = currentRole() === "owner";
  const auth = sessionState.value,
    person = auth.status === "authenticated" ? auth.user.id : "";
  const storageKey = `p1x.import.${encodeURIComponent(person)}`;
  const rememberIds = (ids: { runId: string; planId: string }): void => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ runId: ids.runId, planId: ids.planId }));
    } catch {
      /* progress survives in native maintenance history */
    }
  };
  const remember = (value: ImportRun): void => {
    setRun(value);
    setRunId(value.runId);
    if (terminalRun(value.state)) setAborting(false);
    rememberIds(value);
  };
  const act = async (operation: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(failureOf(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const readStatus = async (id: string): Promise<void> => {
    if (!uuid.test(id)) return;
    const result = await call<{ run: ImportRun }>("admin.import.status", { runId: id }, false);
    remember(result.run);
  };
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { runId?: unknown } | null;
      if (saved && typeof saved.runId === "string" && uuid.test(saved.runId)) {
        setRunId(saved.runId);
        void readStatus(saved.runId).catch((failure) => setError(failureOf(failure)));
      }
    } catch {
      /* no remembered run */
    }
  }, [storageKey]);
  useEffect(() => {
    if (!runId || (run && terminalRun(run.state))) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void call<{ run: ImportRun }>("admin.import.status", { runId }, false)
        .then((result) => {
          if (!stopped) {
            remember(result.run);
            setError(null);
          }
        })
        .catch((failure) => {
          if (!stopped) setError(failureOf(failure));
        })
        .finally(() => {
          polling.current = false;
        });
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, run?.state]);
  useEffect(() => {
    if (!runId || (run && terminalRun(run.state))) return;
    try {
      const stream = getApi().events({
        onEvent: (event) => {
          if (event.event !== "import.progress") return;
          const progress = importProgress(event.data, runId);
          if (progress) setRun((current) => (current?.runId === runId ? { ...current, progress } : current));
        },
      });
      return () => stream.close();
    } catch {
      /* Status polling remains available when this host cannot serve a progress stream. */
    }
  }, [runId, run?.state]);
  const detect = (chosen?: ImportSource, discover = false): void => {
    void act(async () => {
      if (catalog.state.status !== "ok") return;
      const result = await call<AdminImportDetectResult>(
        "admin.import.detect",
        chosen ? { source: chosen } : sourceDetectionRequest(source, catalog.state.data.hostPathsAllowed, discover),
      );
      setRunId("");
      setRun(null);
      if ("discovery" in result) {
        setDiscoveredStores(result.stores ?? []);
        setDiscovery(result);
        setDetected(null);
        setAgents([]);
      } else {
        if (chosen) setDiscoveredStores(discovery?.stores ?? []);
        setDiscovery(null);
        setDetected(result);
        setOptions((current) => {
          const next = { ...current };
          delete next.adoptStoreId;
          delete next.maps;
          delete next.mapProfiles;
          return next;
        });
        setAgents(result.agents.map((agent) => agent.id));
      }
      setPlan(null);
      setPreflight(null);
      setSkills(null);
      setAccepted(false);
      setConflicts({});
    });
  };
  const createPlan = (): void => {
    void act(async () => {
      if (
        !detected ||
        catalog.state.status !== "ok" ||
        !importMappingsReady(options.maps, discoveredStores, catalog.state.data.hostPathsAllowed) ||
        !sourceStoreReady(options.adoptStoreId, detected.stores)
      )
        return;
      const result = await call<AdminImportPlanResult>("admin.import.plan", {
        sourceId: detected.sourceId,
        options: {
          ...options,
          agentIds: agents,
          ...(Object.keys(conflicts).length
            ? { conflicts: Object.entries(conflicts).map(([id, choice]) => ({ id, choice })) }
            : {}),
        },
      });
      setPlan(result);
      setPreflight(null);
      setAccepted(false);
      setConflicts({});
    });
  };
  const inspectPlan = (operation: "apply" | "rollback" = "apply"): void => {
    void act(async () => {
      const planId = operation === "rollback" || run?.resumable ? run?.planId : plan?.planId;
      if (!planId) return;
      setPreflightOperation(operation);
      setAccepted(false);
      setPreflight(await call<AdminImportPreflightResult>("admin.import.preflight", { planId, operation }));
    });
  };
  const apply = (resume = false): void => {
    void act(async () => {
      const selected = resume && run ? { planId: run.planId, runId: run.runId } : plan;
      if (!selected || !preflight) return;
      const result = await call<{ runId: string }>(
        "admin.import.apply",
        applyRequest(selected, preflight, accepted, resume),
      );
      // Core shutdown can interrupt the first status call; the authorized run must already survive a page reload.
      rememberIds({ runId: result.runId, planId: selected.planId });
      setRunId(result.runId);
      setRun(null);
      setAborting(false);
      await readStatus(result.runId);
    });
  };
  const rollback = (): void => {
    void act(async () => {
      if (!run || !preflight) return;
      const request = applyRequest(run, preflight, accepted);
      const result = await call<{ runId: string }>("admin.import.rollback", {
        runId: run.runId,
        preflightId: request.preflightId,
      });
      rememberIds({ runId: result.runId, planId: run.planId });
      setRunId(result.runId);
      setRun(null);
      await readStatus(result.runId);
    });
  };
  const abort = (): void => {
    void act(async () => {
      if (!runId) return;
      const result = importAbortResult(await call("admin.import.abort", { runId }), runId);
      setAborting(result.accepted);
      await readStatus(runId);
    });
  };
  const skillsOnly = (apply: boolean): void => {
    void act(async () => {
      if (!detected || (apply && !skillsAccepted)) return;
      const result = await call<AdminImportSkillsResult>("admin.import.skills", {
        sourceId: detected.sourceId,
        apply,
        onConflict: options.onConflict ?? "skip",
        enable: skillsEnable,
      });
      setSkills(result);
      setSkillsAccepted(false);
    });
  };
  return {
    catalog,
    source,
    setSource,
    detected,
    discovery,
    setDiscovery,
    discoveredStores,
    setDetected,
    agents,
    setAgents,
    options,
    setOptions,
    plan,
    setPlan,
    preflight,
    setPreflight,
    preflightOperation,
    conflicts,
    setConflicts,
    accepted,
    setAccepted,
    run,
    setRun,
    runId,
    setRunId,
    history,
    setHistory,
    skills,
    setSkills,
    skillsAccepted,
    setSkillsAccepted,
    skillsEnable,
    setSkillsEnable,
    busy,
    error,
    setError,
    aborting,
    owner,
    act,
    readStatus,
    remember,
    detect,
    createPlan,
    inspectPlan,
    apply,
    rollback,
    abort,
    skillsOnly,
  };
}
export type ImportFlow = ReturnType<typeof useImportFlow>;
