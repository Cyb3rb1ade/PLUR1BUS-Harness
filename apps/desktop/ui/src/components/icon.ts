const paths = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z",
  connections: "M7 7h11m-3-3 3 3-3 3M17 17H6m3-3-3 3 3 3",
  settings: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z",
  menu: "M4 6h16M4 12h16M4 18h16",
  // #740 Home chip: a screen for bundled and native local connections, a server with an outgoing arrow for remote ones.
  local: "M3 4h18v12H3zM8 20h8M12 16v4",
  remote: "M3 4h12v6H3zM3 14h12v6H3zM6.5 7h.01M6.5 17h.01M18 12h4m-2-2 2 2-2 2",
} as const;

export function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
