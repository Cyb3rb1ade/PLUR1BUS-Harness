import { openSheet } from "../components/sheet.ts";
import type { Connection, ConnectionList, ConnectionSnapshot, DesktopTransport, Paired } from "../ipc.ts";
import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import { chip } from "../components/chip.ts";
import { banner } from "../components/banner.ts";
import { addRemote, type Translate } from "./add-remote.ts";
import { pairingFailure } from "../models/pairing-model.ts";
export function connectionsView(transport: DesktopTransport, translate: Translate, snapshot: () => ConnectionSnapshot, refresh: () => Promise<void>): () => HTMLElement {
    let data: ConnectionList = { connections: [], active: null, tokenStore: null };
    let error: unknown = null;
    let mode: "list" | "add" | "native" = "list";
    let repair: Connection | undefined;
    let selected: string | null = null;
    let opened = false;
    let mount: HTMLElement | null = null;
    let t = translate;
    function paired(result: Paired) { mode = "list"; repair = undefined; selected = result.connection.id; error = null; void refresh(); paint(); }
    function fail(e: unknown) { opened = false; error = e; void refresh(); paint(); }
    function formFocus() { queueMicrotask(() => mount?.querySelector<HTMLInputElement>("input:not([readonly])")?.focus()); }
    function startAdd(row?: Connection) { opened = false; mode = "add"; repair = row; error = null; paint(); formFocus(); }
    function paint() {
        if (!mount)
            return;
        mount.replaceChildren();
        const state = snapshot();
        data = state.data ?? { connections: [], active: null, tokenStore: null };
        if (state.status !== "ready")
            mount.append(banner(t(state.status === "loading" ? "connections.loading" : "connections.loadError"), state.status === "error" ? "error" : "info"));
        if (data.tokenStore === "memory-only")
            mount.append(banner(t("pair.error.keychain-memory-only")));
        if (error) {
            const failure = pairingFailure(error);
            mount.append(banner(t(`pair.error.${failure.error}`) + (failure.versions ? ` ${t("pair.apiVersions", failure.versions)}` : ""), "error"));
        }
        if (opened)
            mount.append(banner(t("connections.selected")));
        if (mode === "add") {
            mount.append(addRemote(t, transport, paired, () => { mode = "list"; paint(); mount?.querySelector<HTMLButtonElement>("button")?.focus(); }, repair));
            return;
        }
        if (mode === "native") {
            const form = element("form", "page-card pairing-form");
            append(form, element("h2", undefined, t("pair.native")), element("p", undefined, t("pair.nativeInfo")));
            const label = element("label", "field");
            label.htmlFor = "native-name";
            const input = element("input");
            input.id = "native-name";
            input.required = true;
            input.maxLength = 120;
            append(label, element("span", undefined, t("pair.name")), input);
            form.append(label);
            const submit = button(t("pair.native"), () => { }, "primary");
            submit.type = "submit";
            append(form, submit, button(t("pair.cancel"), () => { mode = "list"; paint(); }));
            form.addEventListener("submit", async (e) => { e.preventDefault(); submit.disabled = true; try {
                paired(await transport.pairLocal(input.value));
            }
            catch (e) {
                const failure = pairingFailure(e);
                error = e;
                mode = failure.retry === "code" ? "add" : "native";
                paint();
                formFocus();
            } });
            mount.append(form);
            return;
        }
        const actions = element("div", "connection-actions");
        append(actions, button(t("pair.add"), () => startAdd(), "primary"), button(t("pair.native"), () => { opened = false; mode = "native"; error = null; paint(); formFocus(); }), button(t("connections.refresh"), () => void refresh()));
        mount.append(actions);
        const layout = element("div", "connections-layout");
        const list = element("aside", "connections-side");
        list.setAttribute("aria-label", t("connections.title"));
        for (const row of data.connections) {
            const item = button(row.name, () => { selected = row.id; paint(); });
            item.setAttribute("aria-pressed", String(selected === row.id));
            list.append(item, chip(t(`connections.kind.${row.kind}`)));
            if (data.active === row.id)
                list.append(chip(t("connections.active"), "ok"));
        }
        const main = element("div", "connections-main");
        const detail = element("section", "page-card connections-detail");
        append(detail, element("h2", undefined, t("connections.detailTitle")));
        const row = data.connections.find(c => c.id === selected) ?? data.connections[0];
        if (!row && state.status !== "ready") {
            append(layout, list, main, detail);
            mount.append(layout);
            return;
        }
        if (!row) {
            append(main, element("h2", undefined, t("connections.emptyTitle")), element("p", undefined, t("connections.emptyBody")));
            detail.append(element("p", undefined, t("connections.detailBody")));
        }
        else {
            append(main, element("h2", undefined, row.name), element("p", "connection-origin", row.origin));
            if (row.pairingNeeded)
                main.append(banner(t("pair.error.pairing-needed"), "error"));
            if (row.caPin)
                main.append(banner(t("connections.caAdded")));
            if (row.nextCertPin || row.nextCaPin)
                main.append(banner(t("connections.trustNext")));
            const buttons = element("div", "connection-actions");
            append(buttons, button(t("connections.open"), async () => { opened = false; try {
                const result = await transport.openConnection(row.id);
                opened = result.selected && !result.spa_available;
                error = null;
                await refresh();
            }
            catch (e) {
                fail(e);
            } }, "primary"), button(t("pair.repair"), () => startAdd(row)), button(t("connections.rename"), () => rename(row)), button(t("connections.remove"), () => remove(row)));
            main.append(buttons);
            append(detail, element("p", undefined, t(data.tokenStore === null ? "connections.unchecked" : data.tokenStore === "memory-only" ? "connections.memory" : "connections.keychain")), element("p", undefined, `${t("connections.device")}: ${row.tokenHint}`));
            for (const [label, value] of [["connections.currentPin", row.certPin ?? row.caPin], ["connections.observedPin", row.observedCertPin], ["connections.nextPin", row.nextCertPin ?? row.nextCaPin]] as const) {
                if (value)
                    append(detail, element("p", undefined, t(label)), element("code", "connection-pin", value));
            }
            if (row.observedCertPin)
                detail.append(element("p", undefined, t("connections.interception")));
            detail.append(button(t("connections.copy"), async () => { try {
                await navigator.clipboard.writeText([row.name, row.origin, row.certPin ?? row.caPin ?? "", row.observedCertPin ?? ""].join("\n"));
            }
            catch {
                error = "storage";
                paint();
            } }));
        }
        const choose = button(t("connections.choose"), () => { const menu = element("div", "sheet-sections"); for (const item of data.connections)
            menu.append(button(item.name, () => { selected = item.id; document.querySelector<HTMLButtonElement>(".sheet-close")?.click(); paint(); })); openSheet(t("connections.title"), menu, t("panel.close")); });
        choose.classList.add("connection-choose");
        main.prepend(choose);
        const showDetail = button(t("connections.detailTitle"), () => { detail.classList.remove("connections-detail"); openSheet(t("connections.detailTitle"), detail, t("panel.close"), () => { paint(); mount?.querySelector<HTMLElement>(".related-button")?.focus(); }); });
        showDetail.classList.add("related-button");
        main.append(showDetail);
        append(layout, list, main, detail);
        mount.append(layout);
    }
    function rename(row: Connection) { opened = false; if (!mount)
        return; const form = element("form", "page-card pairing-form"); const label = element("label", "field"); label.htmlFor = "rename-name"; const input = element("input"); input.id = "rename-name"; input.value = row.name; input.required = true; input.maxLength = 120; append(label, element("span", undefined, t("pair.name")), input); form.append(label); const save = button(t("connections.save"), () => { }, "primary"); save.type = "submit"; append(form, save, button(t("pair.cancel"), paint)); form.addEventListener("submit", async (e) => { e.preventDefault(); save.disabled = true; try {
        await transport.connectionsRename(row.id, input.value);
        await refresh();
    }
    catch (e) {
        fail(e);
    } }); mount.replaceChildren(form); formFocus(); }
    function remove(row: Connection) { opened = false; if (!mount)
        return; const card = element("section", "page-card"); append(card, element("h2", undefined, t("connections.remove")), element("p", undefined, t("connections.removeConfirm", { name: row.name })), button(t("pair.cancel"), paint), button(t("connections.remove"), async () => { try {
        await transport.connectionsRemove(row.id);
        selected = null;
        await refresh();
    }
    catch (e) {
        fail(e);
    } }, "primary")); mount.replaceChildren(card); queueMicrotask(() => card.querySelector<HTMLButtonElement>("button")?.focus()); }
    return () => { t = translate; mount = element("div", "connections-workspace"); paint(); mount.querySelectorAll<HTMLElement>("button").forEach((node, index) => { node.dataset.focusKey = `connections-${index}`; }); return mount; };
}
