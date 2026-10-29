import { append, element } from "../components/dom.ts";
import { button } from "../components/button.ts";
import type { DesktopTransport } from "../ipc.ts";
import type { createExtensionUpload, UploadConnection } from "../models/extension-upload.ts";
import type { Translate } from "./add-remote.ts";
import { stepUpControls } from "./stepup.ts";

/** The origin is visible before native upload; the host opens the separate package confirmation page afterwards. */
export function extensionUploadView(model: ReturnType<typeof createExtensionUpload>, rows: UploadConnection[],
    transport: DesktopTransport, t: Translate, changed: () => void): HTMLElement {
    const card = element("section", "page-card");
    model.connections(rows);
    append(card, element("h2", undefined, t("extension.reviewTitle")), element("p", undefined, t("extension.reviewExplanation")));
    const label = element("label", "field"); label.htmlFor = "extension-connection";
    const select = element("select"); select.id = "extension-connection";
    const placeholder = element("option"); placeholder.value = ""; placeholder.textContent = t("extension.chooseConnection");
    select.append(placeholder);
    for (const row of rows) { const option = element("option"); option.value = row.id; option.textContent = row.origin; select.append(option); }
    select.value = model.selected ?? ""; select.disabled = model.busy || model.done;
    select.addEventListener("change", () => { model.choose(select.value); changed(); });
    append(label, element("span", undefined, t("extension.destination")), select); card.append(label);
    const origin = rows.find(row => row.id === model.selected)?.origin;
    if (origin) card.append(element("p", "connection-origin", origin));
    if (model.done) card.append(element("p", undefined, t("extension.reviewOpened")));
    else {
        const review = button(t(model.busy ? "extension.uploading" : "extension.review"), () => {
            const work = model.review(request => transport.extensionUpload!(request)); changed(); void work.finally(changed);
        }, "primary");
        review.disabled = !model.selected || model.busy; card.append(review);
    }
    if (model.failed) { const error = element("p", undefined, t(model.mfaRequired ? "stepup.required" : "extension.failed")); error.setAttribute("role", "alert"); card.append(error); }
    if ((model.mfaRequired || model.approval?.value) && model.approval) card.append(stepUpControls(model.approval, transport, t, changed));
    return card;
}
