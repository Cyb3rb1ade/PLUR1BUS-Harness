// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "parse": [
    [
      "GET /__TAG__ 200 __N__\nPOST /x 503 2\n",
      "200:__N__;503:2"
    ],
    [
      "\n",
      ""
    ],
    [
      "GET /x 999 2",
      "error"
    ],
    [
      "GET /x 200 -1",
      "error"
    ]
  ],
  "families": [
    [
      "503:1;200:__N__;201:2",
      "2xx:2;5xx:1"
    ],
    [
      "404:2",
      "4xx:1"
    ],
    [
      "",
      ""
    ],
    [
      "bad",
      "error"
    ]
  ],
  "report": [
    [
      "2xx:__N__;4xx:2;5xx:1",
      "requests=__NP3__;errors=3"
    ],
    [
      "1xx:2",
      "requests=2;errors=0"
    ],
    [
      "",
      "requests=0;errors=0"
    ],
    [
      "2xx:0",
      "error"
    ]
  ],
  "e2e": [
    [
      "GET /__TAG__ 200 __N__\nPOST /x 503 2\n",
      "requests=2;errors=1"
    ],
    [
      "GET /x 404 2\nPUT /y 201 3",
      "requests=2;errors=1"
    ],
    [
      "",
      "requests=0;errors=0"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'go-access-log', ...seedValues(seed) }; }
