// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "group": [
    [
      "__TAG__:__N__;z:-2;__TAG__:__N__",
      "__TAG__:__N2__;z:-2"
    ],
    [
      "b:2;a:1;b:-2",
      "a:1;b:0"
    ],
    [
      "",
      ""
    ],
    [
      "x:no",
      "error"
    ]
  ],
  "aggregate": [
    [
      "__TAG__:__N__;z:__N2__",
      "2,__N3__"
    ],
    [
      "a:-3",
      "1,-3"
    ],
    [
      "",
      "0,0"
    ],
    [
      "bad",
      "error"
    ]
  ],
  "render": [
    [
      "2,__N3__",
      "events=2;total=__N3__"
    ],
    [
      "0,0",
      "events=0;total=0"
    ],
    [
      "1,-2",
      "events=1;total=-2"
    ],
    [
      "-1,2",
      "error"
    ]
  ],
  "e2e": [
    [
      "__TAG__:__N__;z:__N2__;__TAG__:__N__",
      "events=2;total=__N4__"
    ],
    [
      "",
      "events=0;total=0"
    ],
    [
      "a:3;a:-3",
      "events=1;total=0"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'ts-event-ledger', ...seedValues(seed) }; }
