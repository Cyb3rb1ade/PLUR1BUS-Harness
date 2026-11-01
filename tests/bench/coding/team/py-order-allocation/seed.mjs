// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "normalize": [
    [
      "__TAG__/1/__N__;z/2/3;__TAG__/2/__N__",
      "__TAG__/3/__N__;z/2/3"
    ],
    [
      "a/0/1",
      "a/0/1"
    ],
    [
      "",
      ""
    ],
    [
      "a/1/2;a/2/3",
      "error"
    ]
  ],
  "price": [
    [
      "__TAG__/3/__N__",
      "__TAG__:__N3__"
    ],
    [
      "a/2/0;b/2/3",
      "a:0;b:6"
    ],
    [
      "",
      ""
    ],
    [
      "a/-1/2",
      "error"
    ]
  ],
  "receipt": [
    [
      "__TAG__:__N__;z:__N2__",
      "lines=2;total=__N3__"
    ],
    [
      "a:0",
      "lines=1;total=0"
    ],
    [
      "",
      "lines=0;total=0"
    ],
    [
      "x:no",
      "error"
    ]
  ],
  "e2e": [
    [
      "__TAG__/1/__N__;__TAG__/2/__N__",
      "lines=1;total=__N3__"
    ],
    [
      "a/0/1;b/2/3",
      "lines=2;total=6"
    ],
    [
      "",
      "lines=0;total=0"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'py-order-allocation', ...seedValues(seed) }; }
