// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "decode": [
    [
      "ADD __TAG__ __N__;RESERVE __TAG__ __N2__",
      "A,__TAG__,__N__;R,__TAG__,__N2__"
    ],
    [
      "",
      ""
    ],
    [
      "ADD a 0",
      "error"
    ],
    [
      "REMOVE a 1",
      "error"
    ]
  ],
  "apply": [
    [
      "A,__TAG__,__N__;R,__TAG__,__N2__;A,__TAG__,__N__",
      "__TAG__:__N2__"
    ],
    [
      "R,a,1",
      ""
    ],
    [
      "A,a,1;R,a,1",
      "a:0"
    ],
    [
      "X,a,1",
      "error"
    ]
  ],
  "render": [
    [
      "__TAG__:__N__;z:__N2__",
      "skus=2;available=__N3__"
    ],
    [
      "a:0",
      "skus=1;available=0"
    ],
    [
      "",
      "skus=0;available=0"
    ],
    [
      "a:1;a:2",
      "error"
    ]
  ],
  "e2e": [
    [
      "ADD __TAG__ __N__;RESERVE __TAG__ __N2__;ADD __TAG__ __N__",
      "skus=1;available=__N2__"
    ],
    [
      "RESERVE a 1",
      "skus=0;available=0"
    ],
    [
      "ADD a 1;RESERVE a 1",
      "skus=1;available=0"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'go-stock-ledger', ...seedValues(seed) }; }
