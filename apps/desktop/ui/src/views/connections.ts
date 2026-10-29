import { openSheet } from "../components/sheet.ts";
import { enrollmentGrants } from "./enrollment-grants.ts";
import type { EnrollmentGrants } from "../ipc.ts";
import type { Connection, ConnectionList, ConnectionSnapshot, DesktopTransport, Paired, TransportReport, TransportView } from "../ipc.ts";
import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import { chip } from "../components/chip.ts";
import { banner } from "../components/banner.ts";
import { addRemote, resetPairing, type Translate } from "./add-remote.ts";
import { pairingFailure } from "../models/pairing-model.ts";
import { createTransportModel, errorLine, noticeLines, originHost, publicLines, tailscaleNotice } from "../models/transport-model.ts";
import { transportChoice } from "./transport-choice.ts";
import { createStepUp } from "../models/stepup.ts";
import { stepUpControls } from "./stepup.ts";
import type { StepUpPurpose } from "../ipc.ts";
export function connectionsView(transport: DesktopTransport, translate: Translate, snapshot: () => ConnectionSnapshot, refresh: () => Promise<void>): () => HTMLElement {
    let data: ConnectionList = { connections: [], active: null, tokenStore: null };
    let error: unknown = null;
    // Every screen that has input or a pending decision is a mode: the shell rebuilds this view on each late load.
    let mode: "list" | "add" | "native" | "rename" | "remove" = "list";
    let repair: Connection | undefined;
    let subject: string | null = null;
    let renameDraft = "";
    let selected: string | null = null;
    let opened = false;
    let mount: HTMLElement | null = null;
    // Guards live here, not in a rendered button: the shell rebuilds this view on every late load.
    let nativeBusy = false, openBusy = false, removeBusy = false, renameBusy = false;
    let nativeGrants: EnrollmentGrants = {};
    let approvalPurpose: StepUpPurpose = "session";
    let approval: {id: string; purpose: StepUpPurpose; model: ReturnType<typeof createStepUp>} | null = null;
    let t = translate;
    // Transport choice §7.1/§7.3: the last open's report per connection (its notices and chips), and connections
    // whose open or reconnect needs the explicit confirmation, with the fresh report that explains why.
    const reports: Record<string, TransportReport> = {};
    const confirm: Record<string, { report: TransportReport | null; attempt: number; code: string }> = {};
    let confirmBusy = false, attempts = 0;
    const announcedConfirm = new Set<string>();
    function viewOf(row: Connection): TransportView | undefined { return row.kind === "remote" ? data.transports?.[row.id] : undefined; }
    /** `code` is why: `transport-confirm-needed` (an open) or the reconnect's `transport-attention` code. */
    async function needConfirm(row: Connection, code = "transport-confirm-needed") {
        const attempt = ++attempts;
        confirm[row.id] = { report: null, attempt, code };
        paint();
        const view = viewOf(row);
        if (!transport.transportCheck || !view) return;
        try {
            const report = await transport.transportCheck({ kind: "connection", id: row.id }, view.transport, "remote");
            if (confirm[row.id]?.attempt === attempt) confirm[row.id] = { report, attempt, code };
        }
        catch { /* The banner still offers the confirmation; Rust re-checks on every open. */ }
        paint();
    }
    /** A row by id from the shell's current list (this view may not have painted it yet), refreshed once if missing. */
    async function rowFor(id: string): Promise<Connection | undefined> {
        data = snapshot().data ?? data;
        if (!data.connections.some(c => c.id === id)) { await refresh(); data = snapshot().data ?? data; }
        return data.connections.find(c => c.id === id);
    }
    // A stopped reconnect, or a tray switch that needs a confirmation (desktop spec §6.3): the shell opens on this
    // list and the connection shows its confirm panel.
    void transport.transportAttention?.(async event => {
        const row = await rowFor(event.id);
        if (!row) return;
        selected = row.id;
        void needConfirm(row, event.code);
    });
    // A tray switch that opened (the list refreshes) or failed (its reason on the connection).
    void transport.traySwitch?.(async event => {
        if (!event.error) { void refresh(); return; }
        const row = await rowFor(event.id);
        if (row) selected = row.id;
        fail(event.error);
    });
    void transport.stepUpRequired?.(async event => {
        if (!["session", "extensions", "imports"].includes(event.purpose)) return;
        const row = await rowFor(event.id);
        if (!row) return;
        selected = row.id; mode = "list"; approvalPurpose = event.purpose; error = null; paint();
    });
    function paired(result: Paired) { mode = "list"; repair = undefined; selected = result.connection.id; error = null; void refresh(); paint(); }
    function fail(e: unknown) { opened = false; error = e; void refresh(); paint(); }
    function formFocus() { queueMicrotask(() => mount?.querySelector<HTMLInputElement>("input:not([readonly])")?.focus()); }
    function startAdd(row?: Connection) { resetPairing(); opened = false; mode = "add"; repair = row; error = null; paint(); formFocus(); }
    function paint() {
        if (!mount)
            return;
        mount.replaceChildren();
        const state = snapshot();
        data = state.data ?? { connections: [], active: null, tokenStore: null };
        if (state.status === "loading")
            mount.append(banner(t("connections.loading")));
        if (state.status === "error")
            mount.append(banner(t(state.timedOut ? "connections.loadTimeout" : "connections.loadError"), "error"), button(t("connections.retry"), () => void refresh()));
        if (data.tokenStore === "memory-only")
            mount.append(banner(t("pair.error.keychain-memory-only")));
        if (data.transportStore === "read-only-newer")
            mount.append(banner(t("transport.store.newer")));
        if (error) {
            const failed = data.connections.find(c => c.id === selected) ?? data.connections[0];
            const refusal = typeof error === "string" ? errorLine(error, failed ? originHost(failed.origin) : "") : null;
            const failure = pairingFailure(error);
            mount.append(banner(refusal ? t(refusal.key, refusal.values) : t(`pair.error.${failure.error}`) + (failure.versions ? ` ${t("pair.apiVersions", failure.versions)}` : ""), "error"));
        }
        if (opened)
            mount.append(banner(t("connections.selected")));
        if (mode === "rename" || mode === "remove") {
            const target = data.connections.find(c => c.id === subject);
            if (target) {
                mount.append(mode === "rename" ? renameForm(target) : removeCard(target));
                return;
            }
            mode = "list";
            subject = null;
        }
        if (mode === "add") {
            mount.append(addRemote(t, transport, paired, () => { mode = "list"; paint(); mount?.querySelector<HTMLButtonElement>("button")?.focus(); }, repair, undefined, repair ? viewOf(repair) : undefined));
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
            form.append(enrollmentGrants(nativeGrants,t));
            const submit = button(t("pair.native"), () => { }, "primary");
            submit.type = "submit";
            submit.disabled = nativeBusy;
            append(form, submit, button(t("pair.cancel"), () => { mode = "list"; paint(); }));
            form.addEventListener("submit", async (e) => { e.preventDefault(); if (nativeBusy) return; nativeBusy = true; submit.disabled = true; try {
                const result = await transport.pairLocal(input.value,nativeGrants);
                nativeBusy = false;
                paired(result);
            }
            catch (e) {
                nativeBusy = false;
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
        append(actions, button(t("pair.add"), () => startAdd(), "primary"), button(t("pair.native"), () => { opened = false; mode = "native"; error = null; nativeGrants={}; paint(); formFocus(); }), button(t("connections.refresh"), () => void refresh()));
        mount.append(actions);
        const layout = element("div", "connections-layout");
        const list = element("aside", "connections-side");
        list.setAttribute("aria-label", t("connections.title"));
        for (const row of data.connections) {
            const item = button(row.name, () => { selected = row.id; paint(); });
            item.setAttribute("aria-pressed", String(selected === row.id));
            list.append(item, chip(t(`connections.kind.${row.kind}`)));
            list.append(...pathChips(row));
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
            const view = viewOf(row);
            if (view) {
                const line = element("div", "transport-line");
                append(line, element("p", "transport-detail", t("transport.detail", { path: pathText(row, view) })), ...pathChips(row).slice(1));
                const change = button(t("transport.change"), () => changePath(row, view));
                change.dataset.focusKey = "transport-change";
                line.append(change);
                main.append(line);
            }
            if (confirm[row.id])
                main.append(confirmPanel(row));
            const lastOpen = reports[row.id];
            if (lastOpen)
                for (const line of noticeLines(lastOpen)) main.append(banner(t(line.key, line.values)));
            if (row.pairingNeeded)
                main.append(banner(t("pair.error.pairing-needed"), "error"));
            if (row.caPin)
                main.append(banner(t("connections.caAdded")));
            if (row.nextCertPin || row.nextCaPin)
                main.append(banner(t("connections.trustNext")));
            const buttons = element("div", "connection-actions");
            const openButton = button(t("connections.open"), async () => { if (openBusy) return; openBusy = true; openButton.disabled = true; opened = false; try {
                const result = await transport.openConnection(row.id);
                opened = result.selected && !result.spa_available;
                if (result.transport) reports[row.id] = result.transport;
                else delete reports[row.id];
                delete confirm[row.id];
                error = null;
                openBusy = false;
                await refresh();
            }
            catch (e) {
                openBusy = false;
                // Spec §7.1: a public target without a valid confirmation; nothing was contacted.
                if (e === "transport-confirm-needed") { error = null; void needConfirm(row); return; }
                fail(e);
            } }, "primary");
            openButton.disabled = openBusy;
            append(buttons, openButton, button(t("pair.repair"), () => startAdd(row)), button(t("connections.rename"), () => startRename(row)), button(t("connections.remove"), () => startRemove(row)));
            main.append(buttons);
            if (transport.stepUpBegin) {
                const field = element("label", "field"); field.htmlFor = "native-approval-purpose";
                const purpose = element("select"); purpose.id = "native-approval-purpose";
                for (const value of ["session", "extensions", "imports"] as const) {
                    const option = element("option"); option.value = value; option.textContent = t(`stepup.purpose.${value}`); purpose.append(option);
                }
                purpose.value = approvalPurpose;
                purpose.addEventListener("change", () => { approvalPurpose = purpose.value as StepUpPurpose; paint(); });
                append(field, element("span", undefined, t("stepup.purposeLabel")), purpose); main.append(field);
                if (approval?.id !== row.id || approval.purpose !== approvalPurpose) approval = {id: row.id, purpose: approvalPurpose, model: createStepUp(row, approvalPurpose)};
                main.append(stepUpControls(approval.model, transport, t, paint));
            }
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
    /** The path chip (warning tone and text for a public direct path, never colour alone) and a Tailscale chip. */
    function pathChips(row: Connection): HTMLElement[] {
        const view = viewOf(row);
        if (!view) return [];
        const chips: HTMLElement[] = [];
        if (view.transport === "tailscale") chips.push(chip(t("transport.path.tailscale")));
        else if (isPublic(row, view)) chips.push(chip(t("transport.path.public"), "warning"));
        else chips.push(chip(t("transport.path.direct")));
        if (tailscaleNotice(reports[row.id])) chips.push(chip(t("transport.path.tailscale-attention"), "warning"));
        return chips;
    }
    function isPublic(row: Connection, view: TransportView): boolean {
        const known = reports[row.id]?.category ?? confirm[row.id]?.report?.category;
        return known ? known === "public" : view.publicAck;
    }
    function pathText(row: Connection, view: TransportView): string {
        if (view.transport === "tailscale") return t("transport.path.tailscale");
        if (!isPublic(row, view)) return t("transport.path.direct");
        return view.publicAck ? t("transport.path.public-confirmed") : t("transport.path.public");
    }
    /** The confirm-needed state of an open (spec §7.1): the reason, *Bestätigen und verbinden*, *Abbrechen*, *Weg ändern…*. */
    function confirmPanel(row: Connection): HTMLElement {
        const view = viewOf(row);
        const report = confirm[row.id]?.report ?? null;
        const attempt = confirm[row.id]?.attempt ?? 0;
        const panel = element("section", "banner banner-warning transport-public");
        const title = element("h3", "transport-public-title", t("transport.public.title"));
        title.id = `confirm-${row.id}-title`;
        // Announced once per reason; later paints keep it as a named region.
        const key = `${row.id}:${attempt}:${report ? report.hints.map(h => h.code).join(",") : "pending"}`;
        panel.setAttribute("role", announcedConfirm.has(key) ? "region" : "alert");
        announcedConfirm.add(key);
        panel.setAttribute("aria-labelledby", title.id);
        panel.append(title);
        // Without the fresh report (pending or failed) only an explicit `target-changed-public` says "changed";
        // otherwise the first-time text, its addresses not known yet.
        const host = originHost(row.origin);
        const lines = report ? publicLines(report, "remote") : [];
        const fallback = confirm[row.id]?.code === "target-changed-public"
            ? { key: "transport.public.changed" as const, values: { host } }
            : { key: "transport.public.remote" as const, values: { host, addresses: "…" } };
        for (const line of lines.length ? lines : [fallback]) panel.append(element("p", undefined, t(line.key, line.values)));
        if (view?.storeReadOnly) panel.append(element("p", "transport-session", t("transport.public.session")));
        const actions = element("div", "connection-actions");
        const go = button(t("transport.confirm-connect"), async () => {
            if (confirmBusy || !view || !transport.connectionTransportSet) return;
            confirmBusy = true; go.disabled = true;
            try {
                await transport.connectionTransportSet(row.id, view.transport, true);
                const result = await transport.openConnection(row.id);
                delete confirm[row.id];
                if (result.transport) reports[row.id] = result.transport;
                opened = result.selected && !result.spa_available;
                error = null;
                confirmBusy = false;
                await refresh();
            } catch (e) { confirmBusy = false; if (e === "transport-confirm-needed") { void needConfirm(row, confirm[row.id]?.code); return; } fail(e); }
        }, "primary");
        go.disabled = confirmBusy;
        go.dataset.focusKey = "transport-confirm";
        const change = button(t("transport.change"), () => { if (view) changePath(row, view); });
        append(actions, go, button(t("pair.cancel"), () => { delete confirm[row.id]; paint(); }), change);
        panel.append(actions);
        return panel;
    }
    /** *Weg ändern…* (spec §7.1): the chooser, its check and a needed confirmation in a dialog. */
    function changePath(row: Connection, view: TransportView) {
        const model = createTransportModel(transport.transportCheck?.bind(transport), "remote");
        model.setTransport(view.transport);
        model.setTarget({ kind: "connection", id: row.id }, originHost(row.origin));
        const body = element("div", "transport-change");
        const status = element("p", "pair-status");
        status.setAttribute("role", "status");
        let busy = false;
        const save = button(t("connections.save"), async () => {
            const path = model.state.transport;
            if (busy || !path || !model.ready() || !transport.connectionTransportSet) return;
            busy = true; save.disabled = true;
            try {
                await transport.connectionTransportSet(row.id, path, model.state.ack);
                delete confirm[row.id];
                delete reports[row.id];
                document.querySelector<HTMLButtonElement>(".sheet-close")?.click();
                await refresh();
            } catch (e) {
                busy = false;
                const line = typeof e === "string" ? errorLine(e, originHost(row.origin)) : null;
                status.textContent = line ? t(line.key, line.values) : t("pair.error.storage");
                if (e === "transport-confirm-needed") model.checkNow();
                save.disabled = !model.ready();
            }
        }, "primary");
        save.disabled = !model.ready();
        append(body, transportChoice(t, model, { idPrefix: "change-transport", storeReadOnly: view.storeReadOnly, onChange: () => { save.disabled = busy || !model.ready(); } }), status, save);
        openSheet(t("transport.change"), body, t("panel.close"), () => { paint(); mount?.querySelector<HTMLElement>("[data-focus-key=transport-change]")?.focus(); });
    }
    function startRename(row: Connection) { opened = false; error = null; mode = "rename"; subject = row.id; renameDraft = row.name; paint(); formFocus(); }
    function startRemove(row: Connection) { opened = false; error = null; mode = "remove"; subject = row.id; paint(); queueMicrotask(() => mount?.querySelector<HTMLButtonElement>(".page-card button")?.focus()); }
    function leave() { mode = "list"; subject = null; paint(); }
    function renameForm(row: Connection): HTMLElement {
        const form = element("form", "page-card pairing-form");
        const label = element("label", "field");
        label.htmlFor = "rename-name";
        const input = element("input");
        input.id = "rename-name";
        input.value = renameDraft;
        input.required = true;
        input.maxLength = 120;
        input.addEventListener("input", () => { renameDraft = input.value; });
        append(label, element("span", undefined, t("pair.name")), input);
        form.append(label);
        const save = button(t("connections.save"), () => { }, "primary");
        save.type = "submit";
        save.disabled = renameBusy;
        append(form, save, button(t("pair.cancel"), leave));
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            if (renameBusy) return;
            renameBusy = true;
            save.disabled = true;
            try {
                await transport.connectionsRename(row.id, renameDraft);
                renameBusy = false;
                mode = "list";
                subject = null;
                error = null;
                await refresh();
                paint();
            }
            catch (e) {
                renameBusy = false;
                error = e;
                void refresh();
                paint();
                formFocus();
            }
        });
        return form;
    }
    function removeCard(row: Connection): HTMLElement {
        const card = element("section", "page-card");
        const confirm = button(t("connections.remove"), async () => {
            if (removeBusy) return;
            removeBusy = true;
            try {
                await transport.connectionsRemove(row.id);
                selected = null;
                removeBusy = false;
                mode = "list";
                subject = null;
                await refresh();
                paint();
            }
            catch (e) {
                removeBusy = false;
                mode = "list";
                subject = null;
                fail(e);
            }
        }, "primary");
        confirm.disabled = removeBusy;
        append(card, element("h2", undefined, t("connections.remove")), element("p", undefined, t("connections.removeConfirm", { name: row.name })), button(t("pair.cancel"), leave), confirm);
        return card;
    }
    return () => { t = translate; mount = element("div", "connections-workspace"); paint(); mount.querySelectorAll<HTMLElement>("button").forEach((node, index) => { node.dataset.focusKey = `connections-${index}`; }); return mount; };
}
