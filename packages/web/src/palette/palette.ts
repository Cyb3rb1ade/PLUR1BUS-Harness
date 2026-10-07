// The palette's entry point, mounted once by the shell. The dialog and everything it needs (index, matching, fan-out, catalogue) is a
// lazy chunk that loads on the first opening, so the start-up closure only carries the open-state signal and this wrapper.
import { h, type ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../view.ts";
import { paletteOpen } from "./state.ts";

export function Palette(): View | null {
  const open = paletteOpen.value;
  const [Dialog, setDialog] = useState<ComponentType | null>(null);
  useEffect(() => {
    if (open && !Dialog) void import("./dialog.ts").then((m) => { setDialog(() => m.PaletteDialog); });
  }, [open, Dialog]);
  return open && Dialog ? h(Dialog, {}) : null;
}
