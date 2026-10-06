import { h, type VNode } from "preact";

// Inline SVG, stroke 1.75 at 20 px (desktop spec §13.7 rule 9: stroke >= 1.6, no 1 px-only detail).
const PATHS = {
  chat: "M4 5h16v11H9l-5 4z",
  projects: "M3 6h6l2 2h10v11H3z",
  agents: "M12 3l2.5 6 6.5.5-5 4.3 1.6 6.4L12 16.8 6.4 20.2 8 13.8 3 9.5 9.5 9z",
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5",
  memories: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  library: "M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h10",
  skills: "M13 3L5 14h6l-1 7 8-11h-6z",
  plugins: "M9 3v5M15 3v5M6 8h12v4a6 6 0 01-12 0zM12 18v3",
  switchboard: "M4 7h12l-3-3M20 17H8l3 3",
  recurring: "M20 12a8 8 0 10-3 6.2M20 5v7h-7",
  approvals: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5",
  usage: "M5 20V10M12 20V4M19 20v-7",
  logs: "M4 6h16M4 12h16M4 18h10",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17h.01",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeOff: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6zM4 4l16 16",
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 20): VNode {
  return h("svg", {
    class: "icon", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  }, h("path", { d: PATHS[name] }));
}
