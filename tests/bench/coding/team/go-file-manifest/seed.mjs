// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  paths: [
    ["z/../__TAG__:__N__;a/./b:2", "a/b:2;__TAG__:__N__"],
    ["a:2;a:1", "a:1;a:2"],
    ["", ""],
    ["../x:2", "error"],
  ],
  deduplicate: [
    ["__TAG__:__N__;__TAG__:__N2__;z:1", "__TAG__:__N2__;z:1"],
    ["a:0", "a:0"],
    ["", ""],
    ["a/../b:2", "error"],
  ],
  summary: [
    ["__TAG__:__N__;z:__N2__", "files=2;bytes=__N3__"],
    ["a:0", "files=1;bytes=0"],
    ["", "files=0;bytes=0"],
    ["a:1;a:2", "error"],
  ],
  e2e: [
    ["a/../__TAG__:__N__;__TAG__:__N2__", "files=1;bytes=__N2__"],
    ["a:0;b:3", "files=2;bytes=3"],
    ["", "files=0;bytes=0"],
  ],
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "go-file-manifest", ...seedValues(seed) };
}
