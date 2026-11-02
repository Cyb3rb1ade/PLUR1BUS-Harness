// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "backoff": [
    [
      "__N__,__N3__,3",
      "__N__,__N2__,__N3__"
    ],
    [
      "1,3,5",
      "1,2,3,3,3"
    ],
    [
      "1,2,0",
      ""
    ],
    [
      "0,2,3",
      "error"
    ],
    [
      "2,1,1",
      "error"
    ],
    [
      "1,2,101",
      "error"
    ],
    [
      "1,2,-1",
      "error"
    ],
    [
      "1,2",
      "error"
    ],
    [
      "1,2,1,3",
      "error"
    ],
    [
      "1000001,1000001,1",
      "error"
    ],
    [
      "1,1000000001,1",
      "error"
    ],
    [
      "x,2,1",
      "error"
    ],
    [
      "1000000,1000000000,1",
      "1000000"
    ]
  ],
  "deadline": [
    [
      "__N__,__N2__,__N3__",
      "__N__,__N2__,__N3__"
    ],
    [
      "100,100,1",
      "100"
    ],
    [
      "150,1",
      "150"
    ],
    [
      "",
      ""
    ],
    [
      "100,100,no",
      "error"
    ]
  ],
  "summary": [
    [
      "__N__,__N2__,__N3__",
      "attempts=3;elapsed=__N6__"
    ],
    [
      "1",
      "attempts=1;elapsed=1"
    ],
    [
      "",
      "attempts=0;elapsed=0"
    ],
    [
      "0",
      "error"
    ]
  ],
  "e2e": [
    [
      "__N__,__N3__,3",
      "attempts=3;elapsed=__N6__"
    ],
    [
      "100,200,3",
      "attempts=1;elapsed=100"
    ],
    [
      "1,2,0",
      "attempts=0;elapsed=0"
    ]
  ]
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "go-retry-plan", ...seedValues(seed) };
}
