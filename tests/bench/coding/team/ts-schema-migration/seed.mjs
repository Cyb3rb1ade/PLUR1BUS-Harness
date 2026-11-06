// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
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
    ],
    [
      "{\"version\":2,\"accounts\":[{\"id\":\"a\",\"balance\":1},{\"id\":\"a\",\"balance\":2}]}",
      "error"
    ],
    [
      "{\"version\":2,\"accounts\":[null]}",
      "error"
    ],
    [
      "{\"version\":2,\"accounts\":[{\"id\":1,\"balance\":2}]}",
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
const PREFIX = {
  17: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "item_4523540f:12;item_4523540f:12",
        expected: "{\"version\":1,\"rows\":[[\"item_4523540f\",12],[\"item_4523540f\",12]]}",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "Z:2;z:-2",
        expected: "{\"version\":1,\"rows\":[[\"Z\",2],[\"z\",-2]]}",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "",
        expected: "{\"version\":1,\"rows\":[]}",
        prefix: true,
      },
    ],
    migrate: [
      {
        id: "migrate-prefix-1",
        input: "item_4523540f:12;item_4523540f:12",
        expected: "{\"version\":2,\"accounts\":[{\"id\":\"item_4523540f\",\"balance\":24}]}",
        prefix: true,
      },
      {
        id: "migrate-prefix-2",
        input: "Z:2;z:-2",
        expected: "{\"version\":2,\"accounts\":[{\"id\":\"z\",\"balance\":0}]}",
        prefix: true,
      },
      {
        id: "migrate-prefix-3",
        input: "",
        expected: "{\"version\":2,\"accounts\":[]}",
        prefix: true,
      },
    ],
    project: [
      {
        id: "project-prefix-1",
        input: "item_4523540f:12;item_4523540f:12",
        expected: "accounts=1;balance=24",
        prefix: true,
      },
      {
        id: "project-prefix-2",
        input: "Z:2;z:-2",
        expected: "accounts=1;balance=0",
        prefix: true,
      },
      {
        id: "project-prefix-3",
        input: "",
        expected: "accounts=0;balance=0",
        prefix: true,
      },
    ],
  },
  104729: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "item_3893c027:8;item_3893c027:8",
        expected: "{\"version\":1,\"rows\":[[\"item_3893c027\",8],[\"item_3893c027\",8]]}",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "Z:2;z:-2",
        expected: "{\"version\":1,\"rows\":[[\"Z\",2],[\"z\",-2]]}",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "",
        expected: "{\"version\":1,\"rows\":[]}",
        prefix: true,
      },
    ],
    migrate: [
      {
        id: "migrate-prefix-1",
        input: "item_3893c027:8;item_3893c027:8",
        expected: "{\"version\":2,\"accounts\":[{\"id\":\"item_3893c027\",\"balance\":16}]}",
        prefix: true,
      },
      {
        id: "migrate-prefix-2",
        input: "Z:2;z:-2",
        expected: "{\"version\":2,\"accounts\":[{\"id\":\"z\",\"balance\":0}]}",
        prefix: true,
      },
      {
        id: "migrate-prefix-3",
        input: "",
        expected: "{\"version\":2,\"accounts\":[]}",
        prefix: true,
      },
    ],
    project: [
      {
        id: "project-prefix-1",
        input: "item_3893c027:8;item_3893c027:8",
        expected: "accounts=1;balance=16",
        prefix: true,
      },
      {
        id: "project-prefix-2",
        input: "Z:2;z:-2",
        expected: "accounts=1;balance=0",
        prefix: true,
      },
      {
        id: "project-prefix-3",
        input: "",
        expected: "accounts=0;balance=0",
        prefix: true,
      },
    ],
  },
  8675309: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "item_37ba3881:4;item_37ba3881:4",
        expected: "{\"version\":1,\"rows\":[[\"item_37ba3881\",4],[\"item_37ba3881\",4]]}",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "Z:2;z:-2",
        expected: "{\"version\":1,\"rows\":[[\"Z\",2],[\"z\",-2]]}",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "",
        expected: "{\"version\":1,\"rows\":[]}",
        prefix: true,
      },
    ],
    migrate: [
      {
        id: "migrate-prefix-1",
        input: "item_37ba3881:4;item_37ba3881:4",
        expected: "{\"version\":2,\"accounts\":[{\"id\":\"item_37ba3881\",\"balance\":8}]}",
        prefix: true,
      },
      {
        id: "migrate-prefix-2",
        input: "Z:2;z:-2",
        expected: "{\"version\":2,\"accounts\":[{\"id\":\"z\",\"balance\":0}]}",
        prefix: true,
      },
      {
        id: "migrate-prefix-3",
        input: "",
        expected: "{\"version\":2,\"accounts\":[]}",
        prefix: true,
      },
    ],
    project: [
      {
        id: "project-prefix-1",
        input: "item_37ba3881:4;item_37ba3881:4",
        expected: "accounts=1;balance=8",
        prefix: true,
      },
      {
        id: "project-prefix-2",
        input: "Z:2;z:-2",
        expected: "accounts=1;balance=0",
        prefix: true,
      },
      {
        id: "project-prefix-3",
        input: "",
        expected: "accounts=0;balance=0",
        prefix: true,
      },
    ],
  },
};
/** Expand the private semantic and transport cases for one declared seed. */
export function casesForSeed(seed) {
  return checkedCases(TEMPLATE, seed, PREFIX[seed]);
}
/** Return deterministic instance metadata to the trusted materializer. */
export function instanceForSeed(seed) {
  return { taskId: "ts-schema-migration", ...seedValues(seed) };
}
