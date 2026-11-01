// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "decode": [
    [
      "/__TAG__/%20x",
      "/__TAG__/ x"
    ],
    [
      "/%c3%a4",
      "/ä"
    ],
    [
      "a+b",
      "a+b"
    ],
    [
      "/%FF",
      "error"
    ],
    [
      "/%x1",
      "error"
    ]
  ],
  "normalize": [
    [
      "/__TAG__/../ok//./",
      "/ok"
    ],
    [
      "/a/../",
      "/"
    ],
    [
      "/../x",
      "error"
    ],
    [
      "relative",
      "error"
    ]
  ],
  "encode": [
    [
      "/__TAG__/a b",
      "/__TAG__/a%20b"
    ],
    [
      "/ä",
      "/%C3%A4"
    ],
    [
      "/a+b",
      "/a%2Bb"
    ],
    [
      "x",
      "error"
    ]
  ],
  "e2e": [
    [
      "/__TAG__/%2e%2e/a%20b/",
      "/a%20b"
    ],
    [
      "/%c3%a4/./",
      "/%C3%A4"
    ],
    [
      "/a//b/../c",
      "/a/c"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'rs-route-path', ...seedValues(seed) }; }
