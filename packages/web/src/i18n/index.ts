// i18n catalogues, composed from one file per area so that parallel work never edits the same lines.
//
// Convention
//  - `core.ts` holds the shell, navigation, sign-in, session and shared-component texts. Everything else lives in its own
//    area file `<area>.ts` exporting `en` and `de` (same keys, same {placeholders}), keys prefixed `<area>.` (`chat.send`).
//  - To add an area: create `<area>.ts` (copy an empty one) and add ONE line to AREAS below (an import and an entry).
//  - A page agent edits only its own area file. Keys must be unique across areas (test/i18n.test.ts), and de and en must have
//    identical keys and placeholders in every area; both are checked by tests.
//  - `Key` is the union of all keys of all areas, so `t("chat.send")` is checked by the compiler. An area's `de` should be
//    typed `Record<keyof typeof en, string>` once it has keys, so a missing translation fails typecheck at the source.
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import * as budget from "./budget.ts";
import * as chat from "./chat.ts";
import * as core from "./core.ts";
import * as devices from "./devices.ts";
import * as doctor from "./doctor.ts";
import * as logs from "./logs.ts";
import * as memory from "./memory.ts";
import * as models from "./models.ts";
import * as palette from "./palette.ts";
import * as providers from "./providers.ts";
import * as secrets from "./secrets.ts";
import * as sessions from "./sessions.ts";
import * as settings from "./settings.ts";
import * as setup from "./setup.ts";
import * as surfaces from "./surfaces.ts";
import * as switchboard from "./switchboard.ts";
import * as shared from "./shared.ts";
import * as users from "./users.ts";

export type Area = { readonly name: string; readonly en: Readonly<Record<string, string>>; readonly de: Readonly<Record<string, string>> };

/** One line per area; order is only the order of the keys in the merged catalogue. */
export const AREAS = [
  { name: "surfaces", en: surfaces.en, de: surfaces.de },
  { name: "core", en: core.en, de: core.de },
  { name: "chat", en: chat.en, de: chat.de },
  { name: "memory", en: memory.en, de: memory.de },
  { name: "models", en: models.en, de: models.de },
  { name: "budget", en: budget.en, de: budget.de },
  { name: "doctor", en: doctor.en, de: doctor.de },
  { name: "palette", en: palette.en, de: palette.de },
  { name: "shared", en: shared.en, de: shared.de },
  { name: "setup", en: setup.en, de: setup.de },
  { name: "agents", en: agents.en, de: agents.de },
  { name: "settings", en: settings.en, de: settings.de },
  { name: "users", en: users.en, de: users.de },
  { name: "providers", en: providers.en, de: providers.de },
  { name: "secrets", en: secrets.en, de: secrets.de },
  { name: "switchboard", en: switchboard.en, de: switchboard.de },
  { name: "devices", en: devices.en, de: devices.de },
  { name: "logs", en: logs.en, de: logs.de },
  { name: "activity", en: activity.en, de: activity.de },
  { name: "sessions", en: sessions.en, de: sessions.de },
] as const satisfies readonly Area[];

type AreaEn = (typeof AREAS)[number]["en"];
type Intersect<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

export type Key = keyof Intersect<AreaEn> & string;

export const en: Readonly<Record<Key, string>> = Object.assign({}, ...AREAS.map((a) => a.en)) as Record<Key, string>;
export const de: Readonly<Record<Key, string>> = Object.assign({}, ...AREAS.map((a) => a.de)) as Record<Key, string>;
