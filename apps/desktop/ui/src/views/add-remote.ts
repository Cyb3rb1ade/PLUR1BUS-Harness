import type { Connection, DesktopTransport, Paired } from "../ipc.ts";
import type { MessageKey } from "../i18n.ts";
import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import { normalizeOrigin } from "../models/origin-input.ts";
import { pairingFailure } from "../models/pairing-model.ts";
export type Translate = (key: MessageKey, values?: Record<string, string>) => string;
export function addRemote(t: Translate, transport: DesktopTransport, done: (result: Paired) => void, cancel: () => void, repair?: Connection): HTMLElement {
    const form = element("form", "page-card pairing-form");
    append(form, element("h2", undefined, t(repair ? "pair.repair" : "pair.add")), element("p", undefined, t("pair.instructions")));
    function field(label: string, value: string, id: string) { const row = element("label", "field"); row.htmlFor = id; const input = element("input"); input.id = id; input.value = value; input.required = true; append(row, element("span", undefined, label), input); form.append(row); return input; }
    const name = field(t("pair.name"), repair?.name ?? "", "pair-name");
    name.maxLength = 120;
    name.readOnly = !!repair;
    const origin = field(t("pair.origin"), repair?.origin ?? "", "pair-origin");
    origin.maxLength = 2048;
    origin.readOnly = !!repair;
    origin.autocomplete = "off";
    origin.spellcheck = false;
    const validation = element("p", "field-note");
    validation.id = "origin-validation";
    validation.setAttribute("aria-live", "polite");
    origin.setAttribute("aria-describedby", validation.id);
    form.append(validation);
    const codes = element("fieldset", "code-fields");
    append(codes, element("legend", undefined, t("pair.code")));
    const first = element("input"), second = element("input");
    for (const [i, input] of [first, second].entries()) {
        input.maxLength = 4;
        input.minLength = 4;
        input.required = true;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", t(i === 0 ? "pair.codeFirst" : "pair.codeSecond"));
        input.pattern = "[0-9A-HJKMNP-TV-Z]{4}";
        input.addEventListener("input", () => { input.value = input.value.toUpperCase(); });
        codes.append(input);
    }
    form.append(codes, element("p", "field-note", t("pair.once")));
    const status = element("p", "pair-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    form.append(status);
    const footer = element("div", "connection-actions");
    const submit = button(t("pair.submit"), () => { }, "primary");
    submit.type = "submit";
    append(footer, button(t("pair.cancel"), cancel), submit);
    form.append(footer);
    origin.addEventListener("input", () => { const normalized = normalizeOrigin(origin.value); validation.textContent = normalized ?? t("pair.error.insecure-origin"); origin.setAttribute("aria-invalid", String(!normalized)); });
    let busy = false;
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy)
            return;
        const normalized = normalizeOrigin(origin.value);
        if (!normalized) {
            validation.textContent = t("pair.error.insecure-origin");
            origin.setAttribute("aria-invalid", "true");
            origin.focus();
            return;
        }
        busy = true;
        submit.disabled = true;
        status.textContent = t("pair.working");
        try {
            const result = await transport.pairCode({ name: name.value, origin: normalized, code: `${first.value}-${second.value}`, repairId: repair?.id ?? null });
            first.value = "";
            second.value = "";
            done(result);
        }
        catch (error) {
            const failure = pairingFailure(error);
            status.textContent = t(`pair.error.${failure.error}`) + (failure.versions ? ` ${t("pair.apiVersions", failure.versions)}` : "");
            first.value = "";
            second.value = "";
            first.focus();
        }
        finally {
            busy = false;
            submit.disabled = false;
        }
    });
    return form;
}
