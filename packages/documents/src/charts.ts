// Charts and diagrams in the kit's palette and type (D100 §1): a Vega-Lite spec and a Mermaid definition are generated with
// the kit's colours and fonts baked in, never the libraries' default palettes. Rendering happens in the browser (Vega-Lite,
// BSD-3; Mermaid, MIT) like Paged.js; this module produces the spec/definition text so a test can assert the kit colours are
// present and the defaults are absent.

import type { NeutralKit } from "./tokens.ts";

export interface VegaLiteInput {
  readonly mark: "bar" | "line" | "point" | "area" | "arc";
  /** Either inline values or a `data:` URL resolved by the caller. */
  readonly values: readonly Record<string, unknown>[];
  readonly x: string;
  readonly y: string;
  readonly kit: NeutralKit;
}

/** Build a Vega-Lite spec whose mark colour, axis and text all use the kit (not Vega-Lite defaults). */
export function vegaLiteSpec(input: VegaLiteInput): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: input.values },
    mark: input.mark,
    encoding: {
      x: { field: input.x, type: "nominal", axis: { labelColor: input.kit.muted, titleColor: input.kit.muted, gridColor: "#e5e7eb" } },
      y: { field: input.y, type: "quantitative", axis: { labelColor: input.kit.muted, titleColor: input.kit.muted, gridColor: "#e5e7eb" } },
      color: { value: input.kit.accent },
    },
    config: {
      font: "Inter",
      title: { color: input.kit.text, font: "Inter" },
      axis: { labelFont: "Inter", titleFont: "Inter" },
      mark: { color: input.kit.accent },
      background: "transparent",
    },
  };
}

/** The kit hex values a chart spec must reference (used by the test to prove the palette was applied). */
export function chartPalette(kit: NeutralKit): readonly string[] {
  return [kit.accent, kit.text, kit.muted];
}

export interface MermaidInput {
  /** One of the diagram types Mermaid renders without loading external resources. */
  readonly type: "flowchart" | "sequenceDiagram" | "classDiagram" | "stateDiagram-v2";
  readonly body: string;
  readonly kit: NeutralKit;
}

/** Build a Mermaid diagram whose theme variables are the kit colours (Mermaid defaults never survive). */
export function mermaidDefinition(input: MermaidInput): string {
  const init = {
    theme: "base",
    themeVariables: {
      fontFamily: "Inter",
      primaryColor: input.kit.paper,
      primaryTextColor: input.kit.text,
      primaryBorderColor: input.kit.accent,
      lineColor: input.kit.muted,
      secondaryColor: input.kit.accent,
      tertiaryColor: input.kit.paper,
    },
  };
  return `%%{init: ${JSON.stringify(init)}}%%\n${input.type}\n${input.body}`;
}
