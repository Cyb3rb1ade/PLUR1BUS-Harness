/** B1's disposable encrypted eval store. Setup alone reads credential variables; publication reads only stored values. */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { secretFormsIn } from "../logs/redact.ts";
import {
  openTurnEvalSecrets,
  storeTurnEvalCredentials,
  turnEvalSecretName,
  type TurnEvalModel,
} from "./turn-eval-live.ts";

const MARKER = ".coding-eval-home.json";
const MARKER_TEXT = '{"schema":"plur1bus.coding-eval-home/1"}\n';
const CANARY_NAME = "coding-bench/canary";

/** A newly allocated home only; refuse existing directories, including an owner's runtime home. */
export async function setupCodingSecrets(
  home: string,
  models: readonly TurnEvalModel[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  if (!isAbsolute(home)) throw new Error("coding eval home refused");
  // mkdir is exclusive: a failed setup cannot adopt or later delete somebody else's directory.
  await mkdir(home, { mode: 0o700 });
  try {
    await writeFile(join(home, MARKER), MARKER_TEXT, { mode: 0o600, flag: "wx" });
    const store = openTurnEvalSecrets(await codingEvalHome(home));
    await storeTurnEvalCredentials(models, env, store);
    await store.set({ kind: "owner" }, CANARY_NAME, randomBytes(32).toString("base64url"));
  } catch {
    await rm(home, { recursive: true, force: true });
    throw new Error("coding credential setup failed");
  }
}
/** Validate ownership/marker before opening the store, scanning, or deleting any eval-home material. */
export async function codingEvalHome(home: string): Promise<string> {
  if (!isAbsolute(home) || (await realpath(home)) !== resolve(home)) throw new Error("coding eval home refused");
  const directory = await lstat(home);
  const marker = await lstat(join(home, MARKER));
  if (
    !directory.isDirectory() ||
    !marker.isFile() ||
    marker.isSymbolicLink() ||
    marker.size > 1024 ||
    (process.platform !== "win32" &&
      (directory.mode & 0o077 ||
        marker.mode & 0o077 ||
        directory.uid !== process.getuid?.() ||
        marker.uid !== process.getuid?.())) ||
    (await readFile(join(home, MARKER), "utf8")) !== MARKER_TEXT
  )
    throw new Error("coding eval home refused");
  return home;
}
/** Registered raw values stay in memory only, for core redaction and a final raw/encoded publication scan. */
export async function codingSecretValues(home: string, models: readonly TurnEvalModel[]): Promise<string[]> {
  const store = openTurnEvalSecrets(await codingEvalHome(home));
  const names = new Set([CANARY_NAME, ...models.map((model) => turnEvalSecretName(model.provider))]);
  const values: string[] = [];
  for (const name of names) values.push((await store.reveal({ kind: "owner" }, name)).value);
  return values;
}
/** Search captured evaluator output and reports without echoing either a match or a raw exception. */
export async function scanCodingPublications(
  home: string,
  models: readonly TurnEvalModel[],
  files: readonly string[],
): Promise<void> {
  const forms = secretFormsIn(await codingSecretValues(home, models));
  if (!files.length || files.length > 8) throw new Error("coding publication scan refused");
  for (const file of files) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 ** 2) {
      throw new Error("coding publication scan refused");
    }
    const text = await readFile(file, "utf8");
    if (forms.some((form) => text.includes(form))) throw new Error("coding publication scan refused");
  }
}
/** Deletion is limited to a home allocated by this setup; an arbitrary directory always refuses. */
export async function cleanupCodingHome(home: string): Promise<void> {
  await rm(await codingEvalHome(home), { recursive: true, force: true });
}
