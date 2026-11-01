// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "parse": [
    [
      "\"__TAG__\",\"__N__\"\nz,-2\n",
      "__TAG__:__N__;z:-2"
    ],
    [
      "",
      ""
    ],
    [
      "a,2,3",
      "error"
    ],
    [
      "\"a,1",
      "error"
    ],
    [
      "a,\"1",
      "error"
    ]
  ],
  "deduplicate": [
    [
      "__TAG__:__N__;z:2;__TAG__:__N2__",
      "__TAG__:__N2__;z:2"
    ],
    [
      "a:-2;a:-3",
      "a:-2"
    ],
    [
      "",
      ""
    ],
    [
      "a:x",
      "error"
    ]
  ],
  "summary": [
    [
      "a:__N__;b:__N__",
      "count=2;mean=__N__"
    ],
    [
      "a:-2;b:-1",
      "count=2;mean=-2"
    ],
    [
      "",
      "count=0;mean=0"
    ],
    [
      "bad",
      "error"
    ]
  ],
  "e2e": [
    [
      "\"__TAG__\",__N__\n__TAG__,__N2__",
      "count=1;mean=__N2__"
    ],
    [
      "a,-2\nb,-1\n",
      "count=2;mean=-2"
    ],
    [
      "",
      "count=0;mean=0"
    ]
  ]
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "py-csv-import", ...seedValues(seed) };
}
