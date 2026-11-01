// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "decode": [
    [
      "__N__.00@1900",
      "__N100__@1900"
    ],
    [
      "-0.00@0",
      "0@0"
    ],
    [
      "1.2@0",
      "error"
    ],
    [
      "1.00@10001",
      "error"
    ]
  ],
  "tax": [
    [
      "__N100__@1900",
      "__N119__"
    ],
    [
      "1@5000",
      "2"
    ],
    [
      "-1@5000",
      "-2"
    ],
    [
      "0@0",
      "0"
    ],
    [
      "1@-1",
      "error"
    ]
  ],
  "format": [
    [
      "__N119__",
      "__N119EUR__ EUR"
    ],
    [
      "-1",
      "-0.01 EUR"
    ],
    [
      "0",
      "0.00 EUR"
    ],
    [
      "1.2",
      "error"
    ]
  ],
  "e2e": [
    [
      "__N__.00@1900",
      "__N119EUR__ EUR"
    ],
    [
      "-0.01@5000",
      "-0.02 EUR"
    ],
    [
      "0.00@0",
      "0.00 EUR"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'py-money-pipeline', ...seedValues(seed) }; }
