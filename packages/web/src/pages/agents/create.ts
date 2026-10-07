// Multi-step create (`/agents/new`): Name & ID -> Skills (optional) -> Review -> Create. One Attempt (idempotency key) lives for
// the whole wizard, so double clicks and retries never create twice (see model.ts).
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t, type Key } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import { Field, bad } from "../common/field.ts";
import { useLoad } from "../common/load.ts";
import { Notice, UnavailableNote } from "../common/states.ts";
import { ID_RE, NAME_MAX, createAgent, newAttempt, readSkills, reservedId, type Agent, type CreateFailure } from "./model.ts";

const STEPS = ["name", "skills", "review"] as const;
const FAIL_TEXT: Record<Exclude<CreateFailure, "taken" | "invalid">, Key> = {
  conflict: "agents.submit.conflict", forbidden: "agents.submit.forbidden", unavailable: "agents.submit.unavailable", failed: "agents.submit.failed",
};

export type CreateProps = { existing: readonly Agent[]; onCreated: (agent: Agent, already: boolean) => void };

function SkillsStep({ picked, toggle }: { picked: readonly string[]; toggle: (name: string) => void }): View {
  const { state } = useLoad((signal) => readSkills(signal), []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return state.failure.kind === "unavailable" ? h(UnavailableNote, { what: t("agents.skillsStep.legend") }) : h(Notice, { tone: "warn" }, t("agents.skillsStep.failed"));
  if (state.data.length === 0) return h(Notice, {}, t("agents.skillsStep.none"));
  return h("fieldset", { class: "a-skills" },
    h("legend", {}, t("agents.skillsStep.legend")),
    h("p", { class: "field-hint" }, t("agents.skillsStep.hint")),
    state.data.map((name) => h("label", { key: name, class: "a-check" },
      h("input", { type: "checkbox", checked: picked.includes(name), onChange: () => { toggle(name); } }), h("span", {}, name))));
}

export function CreateAgent({ existing, onCreated }: CreateProps): View {
  const attempt = useRef(newAttempt()).current;
  const sending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string>("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { if (first.current) { first.current = false; return; } heading.current?.focus(); }, [step]);

  const trimmed = name.trim();
  const shownId = idTouched ? id : trimmed === "" ? "" : reservedId(name, attempt);
  const nameErr = trimmed === "" ? t("agents.err.nameRequired") : trimmed.length > NAME_MAX ? t("agents.err.nameLong") : undefined;
  const idErr = shownId === "" ? t("agents.err.idRequired") : !ID_RE.test(shownId) ? t("agents.err.idInvalid") : existing.some((a) => a.id === shownId) ? t("agents.err.idTaken") : undefined;

  const next = (to: number): void => {
    if (to > 0 && (nameErr || idErr)) { setShown(true); setStep(0); return; }
    setStep(to);
  };

  const submit = async (): Promise<void> => {
    if (sending.current) return;
    if (nameErr || idErr) { setShown(true); setStep(0); return; }
    sending.current = true; setBusy(true); setFail("");
    const r = await createAgent(attempt, { id: shownId, name: trimmed, skills: picked });
    sending.current = false;
    if (!alive.current) return;
    if (r.ok) { onCreated(r.agent, r.already); return; }
    setBusy(false);
    if (r.kind === "taken") { setShown(true); setStep(0); setFail(t("agents.err.idTaken")); return; }
    setFail(r.kind === "invalid" ? t("agents.submit.invalid", { detail: r.detail ?? "" }) : t(FAIL_TEXT[r.kind]));
  };

  const stepName = t(`agents.step.${STEPS[step]!}` as Key);
  return h("div", { class: "a-create" },
    h("ol", { class: "a-steps", "aria-label": t("agents.steps") }, STEPS.map((s, i) =>
      h("li", { key: s, ...(i === step ? { "aria-current": "step" } : {}), "data-done": String(i < step) }, h("span", { class: "a-step-n" }, String(i + 1)), " ", t(`agents.step.${s}` as Key)))),
    h("h2", { class: "a-step-title", tabIndex: -1, ref: heading }, t("agents.step.of", { n: step + 1, total: STEPS.length, name: stepName })),
    step === 0 ? h("div", {},
      h(Field, { id: "ag-name", label: t("agents.form.name"), hint: t("agents.form.nameHint"), error: shown ? nameErr : undefined },
        h("input", { id: "ag-name", type: "text", autocomplete: "off", value: name, maxLength: 200, "aria-required": true, ...bad(shown ? nameErr : undefined, "ag-name"), onInput: (e: Event) => { setName((e.target as HTMLInputElement).value); } })),
      h(Field, { id: "ag-id", label: t("agents.form.id"), hint: t("agents.form.idHint"), error: shown ? idErr : undefined },
        h("input", { id: "ag-id", type: "text", autocomplete: "off", spellcheck: false, value: shownId, "aria-required": true, "aria-describedby": shown && idErr ? "ag-id-err ag-id-hint" : "ag-id-hint", ...(shown && idErr ? { "aria-invalid": true } : {}), onInput: (e: Event) => { setIdTouched(true); setId((e.target as HTMLInputElement).value.toLowerCase()); } }))) : null,
    step === 1 ? h(SkillsStep, { picked, toggle: (n) => { setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n])); } }) : null,
    step === 2 ? h("div", {},
      h("p", {}, t("agents.review.lead")),
      h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, t("agents.field.name")), h("dd", {}, trimmed)),
        h("div", {}, h("dt", {}, t("agents.field.id")), h("dd", { class: "a-mono" }, shownId)),
        h("div", {}, h("dt", {}, t("agents.field.skills")), h("dd", {}, picked.length === 0 ? t("agents.review.none") : picked.join(", "))))) : null,
    fail ? h("p", { class: "form-error", role: "alert" }, fail) : null,
    h("div", { class: "state-actions a-nav" },
      step === 0 ? h("button", { type: "button", class: "btn btn-quiet", onClick: () => { navigate("/agents"); } }, t("agents.cancel"))
        : h("button", { type: "button", class: "btn", disabled: busy, onClick: () => { next(step - 1); } }, t("agents.back")),
      step < 2 ? h("button", { key: "next", type: "button", class: "btn btn-primary", onClick: () => { next(step + 1); } }, t("agents.next"))
        : h("button", { key: "go", type: "button", class: "btn btn-primary", "aria-disabled": busy, onClick: () => { void submit(); } }, busy ? t("agents.submitting") : t("agents.submit"))));
}
