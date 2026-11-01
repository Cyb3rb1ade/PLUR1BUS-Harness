// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "decode": [
    [
      "__TAGLEN__:__TAG__",
      "__TAG__"
    ],
    [
      "2:ä",
      "ä"
    ],
    [
      "0:",
      ""
    ],
    [
      "1:ä",
      "error"
    ],
    [
      "01:a",
      "error"
    ]
  ],
  "hex": [
    [
      "__TAG__",
      "__TAGHEX__"
    ],
    [
      "ä",
      "c3a4"
    ],
    [
      "A:",
      "413a"
    ],
    [
      "",
      ""
    ]
  ],
  "checksum": [
    [
      "__TAGHEX__",
      "__TAGSUM__"
    ],
    [
      "ff01",
      "00"
    ],
    [
      "C3A4",
      "67"
    ],
    [
      "",
      "00"
    ],
    [
      "0",
      "error"
    ]
  ],
  "e2e": [
    [
      "__TAGLEN__:__TAG__",
      "__TAGSUM__"
    ],
    [
      "2:ä",
      "67"
    ],
    [
      "0:",
      "00"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'rs-frame-checksum', ...seedValues(seed) }; }
