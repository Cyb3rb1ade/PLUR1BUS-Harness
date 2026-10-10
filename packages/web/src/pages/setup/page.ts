// First-run wizard (`/setup`, hidden route, M3 K2): seven steps (six with `?mode=bundled`), each writing through existing RPCs
// (`config.set`, `admin.backup.snapshot`, `models.list`) or showing that the harness has no method (switchboard, import, persona text).
// Progress and the non-secret answers are kept in localStorage under one key (model.ts); the owner token is never stored.
import { getApi } from "../../api/shared.ts";
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { t, type Key } from "../../i18n.ts";
import { query } from "../../router.ts";
import { sessionState } from "../../session.ts";
import type { PageProps } from "../registry.ts";
import { failureOf } from "../common/load.ts";
import { choiceById } from "./licences.ts";
import { changesFor, load, save, stepsFor, validate, type Answers, type Errors, type Saved, type StepId, type Status } from "./model.ts";
import { AccountStep, BackupStep, ImportStep, MemoryStep, ModelStep, PersonaStep, UnavailableStep, type StepProps } from "./steps.ts";
import { MediaSetupStep, type MediaSetupProps } from "../media-search/setup.ts";
import { mediaErrorOf, problemText } from "../media-search/model.ts";
import { registerArea } from "../../i18n/index.ts";
import * as setupArea from "../../i18n/setup.ts";
import "../../styles/setup.css";

registerArea("setup", setupArea);

type MediaProblemCode = MediaSetupProps["error"];

const label = (id: StepId): string => t(`setup.step.${id}` as Key);

function Summary({ steps, st }: { steps: readonly StepId[]; st: Saved }): View {
  const a = st.answers;
  const user = sessionState.value.status === "authenticated" ? sessionState.value.user.id : "";
  const detail = (id: StepId): string => {
    switch (id) {
      case "account": return t("setup.summary.account", { user });
      case "persona": return t("setup.summary.persona", { id: a.agentId, name: a.displayName });
      case "model": return t("setup.summary.model", { model: a.chatModel });
      case "memory": return t("setup.summary.memory", { useClass: t(`setup.memory.use.${a.useClass}` as Key), embedding: choiceById(a.embedding)?.name ?? a.embedding, rerank: choiceById(a.rerank)?.name ?? a.rerank });
      case "backup": return t("setup.summary.backup", { id: a.backupId });
      default: return "";
    }
  };
  return h("ul", { class: "plain-list setup-summary" }, steps.map((id) => {
    const s = st.status[id] ?? "skipped";
    return h("li", { key: id }, h("strong", {}, label(id)), " ", h("span", { class: "badge", "data-tone": s === "done" ? "ok" : "neutral" }, t(`setup.status.${s}`)),
      s === "done" && detail(id) ? h("p", { class: "field-hint" }, detail(id)) : null);
  }));
}

export function SetupPage({ item }: PageProps): View {
  const bundled = query.value.get("mode") === "bundled";
  const defs = stepsFor(bundled);
  const ids = defs.map((d) => d.id);
  const [st, setSt] = useState<Saved>(() => load());
  const [errors, setErrors] = useState<Errors>({});
  const [fail, setFail] = useState("");
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const summary = st.step === "summary";
  const index = summary ? ids.length : Math.max(0, ids.indexOf(st.step as StepId));
  const def = defs[index];
  const total = ids.length;
  const a = st.answers;
  const patch = (p: Partial<Answers>): void => { setSt((s) => ({ ...s, answers: { ...s.answers, ...p } })); setErrors({}); setFail(""); };

  useLayoutEffect(() => { save(st); }, [st]);
  useEffect(() => { if (moved.current) heading.current?.focus(); }, [index, summary]);

  const go = (i: number, status?: Status): void => {
    moved.current = true; setErrors({}); setFail("");
    setSt((s) => {
      const cur = ids[index];
      return { ...s, step: i >= ids.length ? "summary" : ids[Math.max(0, i)]!, status: cur && status ? { ...s.status, [cur]: status } : s.status };
    });
  };

  const next = async (): Promise<void> => {
    if (!def || busy) return;
    const signedIn = sessionState.value.status === "authenticated";
    // The creation time of the agent is fixed when the persona step is first left, so a second pass writes the same value.
    const answers = def.id === "persona" && a.createdAt === "" ? { ...a, createdAt: new Date().toISOString() } : a;
    const errs = validate(def.id, answers, signedIn);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      requestAnimationFrame(() => { document.querySelector<HTMLElement>('[aria-invalid="true"], #setup-backup-create, #setup-token')?.focus(); });
      return;
    }
    const changes = changesFor(def.id, answers);
    if (changes.length > 0) {
      setBusy(true); setFail("");
      try {
        await getApi().rpc("config.set", { changes });
      } catch (e) {
        // A refused media setting names its E_MEDIA_* code; show what the person can do about it.
        const media = mediaErrorOf(e);
        if (media) { setFail(problemText(media)); setBusy(false); return; }
        const k = failureOf(e).kind;
        setFail(k === "forbidden" ? t("setup.err.forbidden") : k === "unavailable" ? t("setup.err.unavailable") : t("setup.err.failed"));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const wantsNc = def.id === "memory" && [answers.embedding, answers.rerank].some((id) => choiceById(id)?.nc === true);
    if (answers !== a) setSt((s) => ({ ...s, answers: { ...s.answers, createdAt: answers.createdAt } }));
    if (def.id === "memory") setSt((s) => ({ ...s, answers: { ...s.answers, ncWritten: wantsNc && !!answers.nc } }));
    go(index + 1, "done");
  };

  const props: StepProps = { a, set: patch, errors, busy };
  let body: View;
  switch (def?.id) {
    case "account": body = h(AccountStep, props); break;
    case "persona": body = h(PersonaStep, props); break;
    case "model": body = h(ModelStep, props); break;
    case "switchboard": body = h(UnavailableStep, { title: t("setup.switchboard.title"), body: t("setup.switchboard.body") }); break;
    case "memory": body = h("div", {}, h(MemoryStep, props),
      h(MediaSetupStep, { textProvider: a.embedding, media: a.media, set: (m) => { patch({ media: { ...a.media, ...m } }); }, error: errors.media as MediaProblemCode })); break;
    case "backup": body = h(BackupStep, props); break;
    default: body = h(ImportStep, {});
  }

  const progress = h("ol", { class: "setup-progress", "aria-label": t("setup.progress") }, defs.map((d, i) => {
    const s = st.status[d.id];
    return h("li", { key: d.id, ...(i === index && !summary ? { "aria-current": "step" } : {}), "data-state": i < index || summary ? "past" : i === index ? "current" : "future" },
      h("span", { class: "setup-num", "aria-hidden": "true" }, String(i + 1)),
      h("span", { class: "setup-name" }, label(d.id)),
      s ? h("span", { class: "sr-only" }, ` (${t(`setup.status.${s}`)})`) : null);
  }));
  const announce = summary ? t("setup.summaryAnnounce") : t("setup.stepOf", { n: index + 1, total, name: label(def!.id) });

  if (summary) {
    return h(Page, { title: t(item.label), lead: t("setup.lead") },
      progress, h("div", { class: "sr-only", role: "status", "aria-live": "polite" }, announce),
      h("section", { class: "card setup-step", "aria-labelledby": "setup-h" },
        h("h2", { id: "setup-h", ref: heading, tabIndex: -1 }, t("setup.summary.title")),
        h("p", { class: "reading" }, t("setup.summary.lead")),
        h(Summary, { steps: ids, st }),
        h("div", { class: "setup-nav" },
          h("button", { type: "button", class: "btn", onClick: () => { go(ids.length - 1); } }, t("setup.back")),
          h("a", { class: "btn btn-primary", href: "#/chat" }, t("setup.summary.chat")))));
  }

  const last = index === total - 1;
  const unavailable = def!.unavailable;
  return h(Page, { title: t(item.label), lead: t("setup.lead") },
    progress,
    h("div", { class: "sr-only", role: "status", "aria-live": "polite" }, announce),
    h("section", { class: "card setup-step", "aria-labelledby": "setup-h" },
      h("p", { class: "setup-count" }, t("setup.stepOf", { n: index + 1, total, name: "" }).replace(/:\s*$/, "")),
      h("h2", { id: "setup-h", ref: heading, tabIndex: -1 }, label(def!.id), def!.skippable ? h("span", { class: "badge", "data-tone": "neutral" }, t("setup.optional")) : null),
      body,
      fail ? h("p", { class: "form-error", role: "alert" }, fail) : null,
      h("div", { class: "setup-nav" },
        h("button", { type: "button", class: "btn", disabled: index === 0, onClick: () => { go(index - 1); } }, t("setup.back")),
        def!.skippable && !unavailable ? h("button", { type: "button", class: "btn btn-quiet", onClick: () => { go(index + 1, "skipped"); } }, t("setup.skip")) : null,
        unavailable
          ? h("button", { type: "button", class: "btn btn-primary", onClick: () => { go(index + 1, "skipped"); } }, last ? t("setup.skipFinish") : t("setup.skip"))
          : h("button", { type: "button", class: "btn btn-primary", disabled: busy, onClick: () => { void next(); } }, busy ? t("setup.working") : last ? t("setup.finish") : t("setup.next")))));
}
