// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "decode": [
    [
      "__TAG__:__N__;z:-2",
      "{\"version\":1,\"rows\":[[\"__TAG__\",__N__],[\"z\",-2]]}"
    ],
    [
      "",
      "{\"version\":1,\"rows\":[]}"
    ],
    [
      "bad",
      "error"
    ]
  ],
  "migrate": [
    [
      "{\"version\":1,\"rows\":[[\"Z\",1],[\"__TAG__\",__N__],[\"Z\",2]]}",
      "{\"version\":2,\"accounts\":[{\"id\":\"__TAG__\",\"balance\":__N__},{\"id\":\"z\",\"balance\":3}]}"
    ],
    [
      "{\"version\":1,\"rows\":[]}",
      "{\"version\":2,\"accounts\":[]}"
    ],
    [
      "{\"version\":3,\"rows\":[]}",
      "error"
    ]
  ],
  "project": [
    [
      "{\"version\":2,\"accounts\":[{\"id\":\"__TAG__\",\"balance\":__N__}]}",
      "accounts=1;balance=__N__"
    ],
    [
      "{\"version\":2,\"accounts\":[]}",
      "accounts=0;balance=0"
    ],
    [
      "{\"version\":1,\"accounts\":[]}",
      "error"
    ]
  ],
  "e2e": [
    [
      "__TAG__:__N__;__TAG__:__N__",
      "accounts=1;balance=__N2__"
    ],
    [
      "Z:2;z:-2",
      "accounts=1;balance=0"
    ],
    [
      "",
      "accounts=0;balance=0"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'ts-schema-migration', ...seedValues(seed) }; }
