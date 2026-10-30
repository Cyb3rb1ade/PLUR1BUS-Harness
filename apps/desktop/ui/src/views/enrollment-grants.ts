import { append, element } from "../components/dom.ts";
import type { EnrollmentGrants } from "../ipc.ts";
import type { Translate } from "./add-remote.ts";

/** Privileged enrollment is a separate, unchecked decision for each surface. */
export function enrollmentGrants(grants: EnrollmentGrants, t: Translate): HTMLElement {
    const group = element("fieldset");
    group.append(element("legend",undefined,t("pair.optionalGrants")));
    for (const key of ["extensions","imports"] as const) {
        const label=element("label","quit-choice");
        const input=element("input"); input.type="checkbox"; input.checked=grants[key]===true;
        input.addEventListener("change",() => { grants[key]=input.checked; });
        append(label,input,element("span",undefined,t(key === "extensions" ? "pair.extensionsGrant" : "pair.importsGrant")));
        group.append(label);
    }
    group.append(element("p",undefined,t("pair.grantsRole")));
    return group;
}
