// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
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
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'ts-release-notes', ...seedValues(seed) }; }
