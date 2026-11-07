/** Public arm definitions shared by B1 and parameterized evaluation families. */
import { createHash } from "node:crypto";

export type CodingArmParameter =
  null | boolean | number | string | readonly CodingArmParameter[] | { readonly [key: string]: CodingArmParameter };
export interface CodingArmSpec {
  family: string;
  params: Readonly<Record<string, CodingArmParameter>>;
}
export interface CodingArmDefinition extends CodingArmSpec {
  id: string;
}

function invalid(): never {
  throw new Error("invalid coding arm");
}

/** Sort object keys, preserve array order, and serialize only finite, bounded JSON data properties. */
function armJson(value: unknown, seen = new Set<object>(), depth = 0, visited = { count: 0 }): string {
  if (++visited.count > 4096 || depth > 32) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)) return invalid();
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      !property.enumerable ||
      !Object.hasOwn(property, "value") ||
      (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))
    )
      invalid();
  }
  seen.add(value);
  try {
    return array
      ? `[${Array.from({ length: value.length }, (_, index) => armJson(properties[index]!.value, seen, depth + 1, visited)).join(",")}]`
      : `{${(keys as string[])
          .sort()
          .map((key) => `${JSON.stringify(key)}:${armJson(properties[key]!.value, seen, depth + 1, visited)}`)
          .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function definitionParts(arm: CodingArmSpec): { family: string; json: string } {
  if (!arm || typeof arm !== "object") invalid();
  const properties = Object.getOwnPropertyDescriptors(arm);
  const family: unknown = properties.family?.value;
  const params: unknown = properties.params?.value;
  if (
    typeof family !== "string" ||
    !/^[a-z][a-z0-9+-]{0,30}$/u.test(family) ||
    !params ||
    typeof params !== "object" ||
    Array.isArray(params)
  )
    invalid();
  const json = armJson(params);
  if (Buffer.byteLength(json, "utf8") > 16_384) invalid();
  return { family, json };
}

function identity({ family, json }: ReturnType<typeof definitionParts>): string {
  if (family === "single" && json === "{}") return "single";
  const descriptor = `{"family":${JSON.stringify(family)},"params":${json}}`;
  const digest = createHash("sha256").update(descriptor, "utf8").digest("hex").slice(0, 32);
  return `${family.replaceAll("+", "-")}-${digest}`;
}

/** Matches TM2's existing portable encoding; the empty single control keeps its established ID. */
export function canonicalArmId(arm: CodingArmSpec): string {
  return identity(definitionParts(arm));
}

/** Retain a normalized private copy so caller mutation cannot silently change published arm metadata. */
export function defineCodingArm(arm: CodingArmSpec): CodingArmDefinition {
  const parts = definitionParts(arm);
  return { id: identity(parts), family: parts.family, params: JSON.parse(parts.json) as CodingArmSpec["params"] };
}

/** Published arms have exactly these three fields, with an ID recomputed from their complete definition. */
export function parseCodingArmDefinition(value: unknown): CodingArmDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => typeof key !== "string" || !["id", "family", "params"].includes(key)))
    invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of ["id", "family", "params"]) {
    if (!properties[key]?.enumerable || !Object.hasOwn(properties[key]!, "value")) invalid();
  }
  const definition = defineCodingArm({ family: properties.family!.value, params: properties.params!.value });
  if (properties.id!.value !== definition.id) invalid();
  return definition;
}
