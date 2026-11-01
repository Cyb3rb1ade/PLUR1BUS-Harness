// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "merge": [
    [
      "__N2__..__N3__,0..__N__,__N__..__N2__",
      "0..__N3__"
    ],
    [
      "1..2,5..6",
      "1..2,5..6"
    ],
    [
      "",
      ""
    ],
    [
      "4..4",
      "error"
    ]
  ],
  "gaps": [
    [
      "0..__N__,__N2__..100",
      "__N__..__N2__"
    ],
    [
      "0..100",
      ""
    ],
    [
      "",
      "0..100"
    ],
    [
      "5..10,2..4",
      "error"
    ]
  ],
  "choose": [
    [
      "0..__N__,__N2__..__N3__",
      "0..__N__"
    ],
    [
      "20..30,0..5",
      "20..30"
    ],
    [
      "",
      "none"
    ],
    [
      "4..3",
      "error"
    ]
  ],
  "e2e": [
    [
      "__N__..__N2__,__N2__..100",
      "0..__N__"
    ],
    [
      "0..100",
      "none"
    ],
    [
      "",
      "0..100"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'ts-calendar', ...seedValues(seed) }; }
