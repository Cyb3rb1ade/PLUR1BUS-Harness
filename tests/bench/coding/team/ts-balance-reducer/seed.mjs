// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "decode": [
    [
      "add=__N__;sub=__N2__",
      "[[\"add\",__N__],[\"sub\",__N2__]]"
    ],
    [
      "",
      "[]"
    ],
    [
      "add=0",
      "error"
    ]
  ],
  "reduce": [
    [
      "[[\"add\",__N__],[\"sub\",__N2__],[\"add\",__N__]]",
      "{\"balance\":__N2__,\"accepted\":2,\"rejected\":1}"
    ],
    [
      "[]",
      "{\"balance\":0,\"accepted\":0,\"rejected\":0}"
    ],
    [
      "[[\"unknown\",1]]",
      "error"
    ]
  ],
  "report": [
    [
      "{\"balance\":__N__,\"accepted\":2,\"rejected\":1}",
      "balance=__N__;accepted=2;rejected=1"
    ],
    [
      "{\"balance\":0,\"accepted\":0,\"rejected\":0}",
      "balance=0;accepted=0;rejected=0"
    ],
    [
      "{\"balance\":-1,\"accepted\":0,\"rejected\":0}",
      "error"
    ]
  ],
  "e2e": [
    [
      "add=__N__;sub=__N2__;add=__N__",
      "balance=__N2__;accepted=2;rejected=1"
    ],
    [
      "sub=2",
      "balance=0;accepted=0;rejected=1"
    ],
    [
      "",
      "balance=0;accepted=0;rejected=0"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'ts-balance-reducer', ...seedValues(seed) }; }
