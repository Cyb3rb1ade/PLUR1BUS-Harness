// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "versions": [
    [
      "v1.__N__.2,1.2.9,1.__N__.2",
      "1.2.9,1.__N__.2"
    ],
    [
      "10.0.0,2.0.0",
      "2.0.0,10.0.0"
    ],
    [
      "",
      ""
    ],
    [
      "01.2.3",
      "error"
    ]
  ],
  "latest": [
    [
      "1.2.9,1.__N__.2",
      "1.__N__.2"
    ],
    [
      "10.0.0,2.0.0",
      "10.0.0"
    ],
    [
      "",
      "none"
    ],
    [
      "1.2",
      "error"
    ]
  ],
  "notes": [
    [
      "1.__N__.2",
      "## Release 1.__N__.2\n"
    ],
    [
      "0.0.0",
      "## Release 0.0.0\n"
    ],
    [
      "none",
      "No releases\n"
    ],
    [
      "v1.0.0",
      "error"
    ]
  ],
  "e2e": [
    [
      "v1.__N__.2,1.2.9",
      "## Release 1.__N__.2\n"
    ],
    [
      "10.0.0,2.0.0",
      "## Release 10.0.0\n"
    ],
    [
      "",
      "No releases\n"
    ]
  ]
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "ts-release-notes", ...seedValues(seed) };
}
