// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "decode": [
    [
      "__TAGLEN__:__TAG__",
      "__TAG__"
    ],
    [
      "2:Ä",
      "Ä"
    ],
    [
      "0:",
      ""
    ],
    [
      "1:Ä",
      "error"
    ]
  ],
  "normalize": [
    [
      "  __TAG__  ",
      "__TAG__"
    ],
    [
      " ÄÖ ",
      "äö"
    ],
    [
      "",
      ""
    ],
    [
      "AbC",
      "abc"
    ]
  ],
  "encode": [
    [
      "__TAG__",
      "__TAGLEN__:__TAG__"
    ],
    [
      "ä",
      "2:ä"
    ],
    [
      "",
      "0:"
    ],
    [
      "abc",
      "3:abc"
    ]
  ],
  "e2e": [
    [
      "__TAGLEN__:__TAG__",
      "__TAGLEN__:__TAG__"
    ],
    [
      "5: ABC ",
      "3:abc"
    ],
    [
      "2:Ä",
      "2:ä"
    ],
    [
      "0:",
      "0:"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'rs-frame-pipeline', ...seedValues(seed) }; }
