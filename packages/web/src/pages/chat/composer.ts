import { h } from "preact";
import type { RefObject } from "preact";
import { useId } from "preact/hooks";
import { t } from "../../i18n.ts";
import type { View } from "../../view.ts";

export type ComposerProps = {
  /** Accessible name of the text box (a visually hidden label). */
  label: string;
  placeholder?: string;
  value: string;
  onInput: (value: string) => void;
  /** Enter, or the Send button. Called only when there is text to send. */
  onSend: () => void;
  sendLabel: string;
  /** False while a send is in flight. */
  ready: boolean;
  /** A reply is being written: the Send button is replaced by Stop. */
  running?: boolean;
  onStop?: () => void;
  box: RefObject<HTMLTextAreaElement>;
};

/** Text box + Send/Stop. Enter sends, Shift+Enter adds a line, focus stays in the box; the Send button is aria-disabled
 *  (not disabled) when there is nothing to send, so keyboard focus never falls off it. */
export function Composer({ label, placeholder, value, onInput, onSend, sendLabel, ready, running = false, onStop, box }: ComposerProps): View {
  const id = useId();
  const hint = `${id}-hint`;
  const blank = value.trim() === "";
  const canSend = ready && !running && !blank;
  const send = (): void => { if (canSend) onSend(); };
  return h("div", { class: "chat-compose" },
    h("label", { class: "sr-only", for: id }, label),
    h("textarea", {
      id, ref: box, rows: 2, value, "aria-describedby": hint, ...(placeholder ? { placeholder } : {}),
      onInput: (e: Event) => { onInput((e.target as HTMLTextAreaElement).value); },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        send();
      },
    }),
    h("div", { class: "chat-compose-row" },
      h("p", { class: "chat-hint", id: hint }, t("chat.compose.hint")),
      running
        ? h("button", { type: "button", class: "btn", onClick: () => { onStop?.(); } }, t("chat.stop"))
        : h("button", { type: "button", class: "btn btn-primary", "aria-disabled": String(!canSend), onClick: send }, sendLabel)));
}
