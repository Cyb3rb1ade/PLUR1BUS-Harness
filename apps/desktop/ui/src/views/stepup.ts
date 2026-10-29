import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import type { DesktopTransport } from "../ipc.ts";
import type { createStepUp } from "../models/stepup.ts";
import type { Translate } from "./add-remote.ts";

export function stepUpControls(model: ReturnType<typeof createStepUp>, transport: DesktopTransport,
  t: Translate, changed: () => void): HTMLElement {
  const box = element("section", "page-card");
  append(box, element("h3", undefined, t("stepup.title")), element("p", undefined, t(`stepup.purpose.${model.purpose}`)));
  if (!transport.stepUpBegin || !transport.stepUpPoll || !transport.stepUpCancel || !transport.stepUpOpen) {
    box.append(element("p", undefined, t("stepup.unavailable"))); return box;
  }
  const action = (work: Promise<unknown>) => { changed(); void work.finally(changed); };
  const value = model.value;
  if (!value || value.state === "declined" || value.state === "expired") {
    if (value) box.append(element("p", undefined, t(`stepup.${value.state}`)));
    const begin = button(t("stepup.begin"), () => action(model.begin(transport.stepUpBegin!)), "primary");
    begin.disabled = model.busy; box.append(begin);
  } else {
    append(box, element("p", "connection-origin", value.verificationUri), element("p", "verification-code", value.userCode));
    append(box, element("p", undefined, t("stepup.expires", {when: new Date(value.expiresAt).toLocaleTimeString()})),
      element("p", undefined, t(`stepup.${value.state}`)));
    const open = button(t("stepup.open"), () => action(model.open(transport.stepUpOpen!)));
    const poll = button(t("stepup.check"), () => action(model.poll(transport.stepUpPoll!)), "primary");
    const cancel = button(t("stepup.cancel"), () => action(model.cancel(transport.stepUpCancel!)));
    open.disabled = model.busy; poll.disabled = model.busy || value.state === "approved"; cancel.disabled = false;
    append(box, open, poll, cancel);
  }
  if (model.error) { const error = element("p", undefined, model.retryAfter ? t("stepup.rateLimited", {seconds:String(model.retryAfter)}) : t("stepup.failed")); error.setAttribute("role", "alert"); box.append(error); }
  return box;
}
