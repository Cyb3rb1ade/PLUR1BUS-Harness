import type { VNode } from "preact";

/** Return type of every component and view helper. Preact's own `VNode<{}>` default is not assignable from
 * `h(...)` results under `exactOptionalPropertyTypes` (tsconfig.base.json), so views are typed loosely here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type View = VNode<any>;
