/** Verify the vendored JPEG source receipt, permitted modifications, and retained licence files. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(root, "upstream-source.json"), "utf8"));
const localFiles = new Set(["PLUR1BUS-PATCH.md", "upstream-source.json", "verify-source.mjs"]);
const modified = new Set(receipt.modifiedFiles);
for (const file of receipt.files) {
  if (file.path.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`invalid relative source path: ${file.path}`);
  }
  const hash = createHash("sha256").update(readFileSync(join(root, file.path))).digest("hex");
  if (hash !== file.localSha256 || (!modified.has(file.path) && hash !== file.upstreamSha256)) {
    throw new Error(`vendored source receipt mismatch: ${file.path}`);
  }
  localFiles.add(file.path);
}
for (const licence of ["LICENSE-MIT", "LICENSE-APACHE", "LICENSE-ZLIB"]) {
  if (!localFiles.has(licence)) throw new Error(`missing upstream licence: ${licence}`);
}
function inspect(directory, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) inspect(join(directory, entry.name), relative + "/");
    else if (!entry.isFile() || !localFiles.delete(relative)) {
      throw new Error(`unexpected vendored source entry: ${relative}`);
    }
  }
}
inspect(root);
if (localFiles.size !== 0) {
  throw new Error(`missing vendored source files: ${[...localFiles].join(", ")}`);
}
console.log(`Verified ${receipt.files.length} published files; ${modified.size} modified HV files; licence texts retained.`);
