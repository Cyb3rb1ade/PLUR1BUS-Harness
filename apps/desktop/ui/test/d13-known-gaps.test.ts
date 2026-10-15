import { test } from "node:test";

// Each gap needs a change on the native side (apps/desktop/src-tauri) or a wire-format decision, so it is not fixed in the UI.
test("KNOWN GAP: harness_logs_tail returns raw container output; native redaction is needed besides the UI mask", { todo: true });
test("KNOWN GAP: invoke calls carry no deadline or cancel; a hung pair_code, connections_list or harness_logs_tail keeps its view loading until the native side answers", { todo: true });
test("KNOWN GAP: the rename form is not a view mode, so any shell re-render drops it together with the typed name", { todo: true });
test("KNOWN GAP: update_install gives no progress events to the offer dialog; the button stays disabled with no feedback until the app restarts", { todo: true });
