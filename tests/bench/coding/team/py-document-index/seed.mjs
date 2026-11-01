// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "tokens": [
    [
      "Hello, WORLD! 42",
      "hello world 42"
    ],
    [
      "Äpfel_Öl",
      "äpfel öl"
    ],
    [
      "__TAG__",
      "__TAGWORD__"
    ],
    [
      "",
      ""
    ]
  ],
  "index": [
    [
      "a b a",
      "a:2;b:1"
    ],
    [
      "z   a",
      "a:1;z:1"
    ],
    [
      "",
      ""
    ],
    [
      "öl öl äpfel",
      "äpfel:1;öl:2"
    ]
  ],
  "rank": [
    [
      "a:__N__;b:__N__",
      "a"
    ],
    [
      "z:2;a:1",
      "z"
    ],
    [
      "",
      "none"
    ],
    [
      "a:0",
      "error"
    ]
  ],
  "e2e": [
    [
      "Hello, hello world",
      "hello"
    ],
    [
      "Öl äpfel öl",
      "öl"
    ],
    [
      "",
      "none"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'py-document-index', ...seedValues(seed) }; }
