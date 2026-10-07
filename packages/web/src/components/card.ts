import { h, type ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import type { View } from "../view.ts";

export type CardProps = {
  title?: string;
  /** Heading level of the title (default 2; use 3 inside a section that already has an h2). */
  level?: 2 | 3 | 4;
  /** Right-aligned header content (a Badge, a button). */
  aside?: ComponentChildren;
  children?: ComponentChildren;
};

/** A bordered surface with an optional heading. `h(Card, { title: t("models.local"), aside: h(Badge, { tone: "ok" }, "ready") }, body)` */
export function Card({ title, level = 2, aside, children }: CardProps): View {
  const id = useId();
  return h("div", { class: "card", ...(title ? { role: "group", "aria-labelledby": id } : {}) },
    title ? h("div", { class: "card-head" }, h(`h${level}`, { id, class: "card-title" }, title), aside ?? null) : null,
    children);
}

export type BadgeTone = "neutral" | "ok" | "warn" | "err" | "info";

/** A short status label. The text carries the meaning; the tone only adds colour. `h(Badge, { tone: "warn" }, t("budget.nearLimit"))` */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children?: ComponentChildren }): View {
  return h("span", { class: "badge", "data-tone": tone }, children);
}
