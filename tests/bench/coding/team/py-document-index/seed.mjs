// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "tokens": [
    [
      "hello\r\nworld",
      "hello world"
    ],
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
    ],
    [
      "a:1;a:2",
      "error"
    ],
    [
      "missing",
      "error"
    ],
    [
      ":1",
      "error"
    ],
    [
      "a:x",
      "error"
    ],
    [
      "a:-1",
      "error"
    ]
  ],
  "e2e": [
    [
      "Hello, hello world",
      "{\"term\":\"hello\",\"bytes\":5}"
    ],
    [
      "Öl äpfel öl",
      "{\"term\":\"öl\",\"bytes\":3}"
    ],
    [
      "",
      "{\"term\":null,\"bytes\":0}"
    ]
  ],
  "lookup": [
    [
      "hello",
      "{\"term\":\"hello\",\"bytes\":5}"
    ],
    [
      "öl",
      "{\"term\":\"öl\",\"bytes\":3}"
    ],
    [
      "none",
      "{\"term\":null,\"bytes\":0}"
    ],
    [
      "A-b",
      "error"
    ]
  ]
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "py-document-index", ...seedValues(seed) };
}
