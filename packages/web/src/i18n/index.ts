// i18n catalogues, composed from one file per area so that parallel work never edits the same lines.
//
// Convention
//  - `core.ts` holds the shell, navigation, sign-in, session and shared-component texts. Everything else lives in its own
//    area file `<area>.ts` exporting `en` and `de` (same keys, same {placeholders}), keys prefixed `<area>.` (`chat.send`).
//  - To add an area: create `<area>.ts` (copy an empty one) and add ONE line to EAGER_AREAS below (an import and an entry).
//    An area used by a single lazy page chunk stays out of the start-up bundle instead: type-only import here, `registerArea` call in the chunk.
//  - A page agent edits only its own area file. Keys must be unique across areas (test/i18n.test.ts), and de and en must have
//    identical keys and placeholders in every area; both are checked by tests.
//  - `Key` is the union of all keys of all areas, so `t("chat.send")` is checked by the compiler. An area's `de` should be
//    typed `Record<keyof typeof en, string>` once it has keys, so a missing translation fails typecheck at the source.
import type * as activity from "./activity.ts";
import type * as agents from "./agents.ts";
import type * as approvals from "./approvals.ts";
import type * as budget from "./budget.ts";
import type * as chat from "./chat.ts";
import * as core from "./core.ts";
import type * as devices from "./devices.ts";
import type * as doctor from "./doctor.ts";
import type * as extensions from "./extensions.ts";
import type * as logs from "./logs.ts";
import * as memory from "./memory.ts";
import * as mediasearch from "./mediasearch.ts";
import * as models from "./models.ts";
import * as palette from "./palette.ts";
import type * as providers from "./providers.ts";
import type * as recurring from "./recurring.ts";
import type * as secrets from "./secrets.ts";
import type * as sessions from "./sessions.ts";
import * as settings from "./settings.ts";
import type * as setup from "./setup.ts";
import * as surfaces from "./surfaces.ts";
import type * as voice from "./voice.ts";
import type * as switchboard from "./switchboard.ts";
import * as shared from "./shared.ts";
import type * as users from "./users.ts";

export type Area = { readonly name: string; readonly en: Readonly<Record<string, string>>; readonly de: Readonly<Record<string, string>> };

/** One line per area; order is only the order of the keys in the merged catalogue. */
const EAGER_AREAS = [
  { name: "surfaces", en: surfaces.en, de: surfaces.de },
  { name: "core", en: core.en, de: core.de },
  { name: "memory", en: memory.en, de: memory.de },
  { name: "mediasearch", en: mediasearch.en, de: mediasearch.de },
  { name: "models", en: models.en, de: models.de },
  { name: "palette", en: palette.en, de: palette.de },
  { name: "shared", en: shared.en, de: shared.de },
  { name: "settings", en: settings.en, de: settings.de },
] as const satisfies readonly Area[];

/** Areas that only one lazy page chunk uses. They are not part of the start-up closure: the chunk imports its own catalogue and
 *  calls `registerArea` as it loads (before it renders), which merges the texts into `en` / `de` and adds it to AREAS. Their keys
 *  are still part of `Key` through the type-only imports above. `LAZY_ORDER` is the canonical position in AREAS. */
type LazyAreaName =
  | "providers"
  | "switchboard"
  | "approvals"
  | "chat"
  | "budget"
  | "doctor"
  | "setup"
  | "agents"
  | "users"
  | "secrets"
  | "devices"
  | "logs"
  | "activity"
  | "sessions"
  | "voice"
  | "extensions"
  | "recurring";

const LAZY_ORDER: readonly string[] = [
  "surfaces", "core", "chat", "memory", "mediasearch", "models", "budget", "doctor", "palette", "shared", "setup", "agents", "settings", "users",
  "providers", "secrets", "switchboard", "devices", "logs", "activity", "sessions", "approvals", "voice", "extensions", "recurring",
];

type AreaEn =
  | (typeof EAGER_AREAS)[number]["en"]
  | typeof providers.en
  | typeof switchboard.en
  | typeof approvals.en
  | typeof chat.en
  | typeof memory.en
  | typeof budget.en
  | typeof doctor.en
  | typeof setup.en
  | typeof agents.en
  | typeof users.en
  | typeof secrets.en
  | typeof devices.en
  | typeof logs.en
  | typeof activity.en
  | typeof sessions.en
  | typeof voice.en
  | typeof extensions.en
  | typeof recurring.en;
type Intersect<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

export type Key = keyof Intersect<AreaEn> & string;

export const en: Readonly<Record<Key, string>> = Object.assign({}, ...EAGER_AREAS.map((a) => a.en)) as Record<Key, string>;
export const de: Readonly<Record<Key, string>> = Object.assign({}, ...EAGER_AREAS.map((a) => a.de)) as Record<Key, string>;

/** Every area registered so far, in canonical order (the eager ones plus the lazy ones whose chunk has loaded). */
export const AREAS: Area[] = [...EAGER_AREAS];

/** Called by a lazy page chunk for its own catalogue; idempotent. */
export function registerArea(name: LazyAreaName, area: { readonly en: Readonly<Record<string, string>>; readonly de: Readonly<Record<string, string>> }): void {
  if (AREAS.some((a) => a.name === name)) return;
  Object.assign(en, area.en);
  Object.assign(de, area.de);
  const rank = (n: string): number => LAZY_ORDER.indexOf(n);
  const at = AREAS.findIndex((a) => rank(a.name) > rank(name));
  AREAS.splice(at < 0 ? AREAS.length : at, 0, { name, en: area.en, de: area.de });
}
