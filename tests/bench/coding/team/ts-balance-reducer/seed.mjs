// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  decode: [
    ["add=__N__;sub=__N2__", "[[\"add\",__N__],[\"sub\",__N2__]]"],
    ["", "[]"],
    ["add=0", "error"],
  ],
  reduce: [
    ["[[\"add\",__N__],[\"sub\",__N2__],[\"add\",__N__]]", "{\"balance\":__N2__,\"accepted\":2,\"rejected\":1}"],
    ["[]", "{\"balance\":0,\"accepted\":0,\"rejected\":0}"],
    ["[[\"unknown\",1]]", "error"],
  ],
  report: [
    ["{\"balance\":__N__,\"accepted\":2,\"rejected\":1}", "balance=__N__;accepted=2;rejected=1"],
    ["{\"balance\":0,\"accepted\":0,\"rejected\":0}", "balance=0;accepted=0;rejected=0"],
    ["{\"balance\":-1,\"accepted\":0,\"rejected\":0}", "error"],
  ],
  e2e: [
    ["add=__N__;sub=__N2__;add=__N__", "balance=__N2__;accepted=2;rejected=1"],
    ["sub=2", "balance=0;accepted=0;rejected=1"],
    ["", "balance=0;accepted=0;rejected=0"],
  ],
};
const PREFIX = {
  17: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "add=12;sub=24;add=12",
        expected: "[[\"add\",12],[\"sub\",24],[\"add\",12]]",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "sub=2",
        expected: "[[\"sub\",2]]",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "",
        expected: "[]",
        prefix: true,
      },
    ],
    reduce: [
      {
        id: "reduce-prefix-1",
        input: "add=12;sub=24;add=12",
        expected: "{\"balance\":24,\"accepted\":2,\"rejected\":1}",
        prefix: true,
      },
      {
        id: "reduce-prefix-2",
        input: "sub=2",
        expected: "{\"balance\":0,\"accepted\":0,\"rejected\":1}",
        prefix: true,
      },
      {
        id: "reduce-prefix-3",
        input: "",
        expected: "{\"balance\":0,\"accepted\":0,\"rejected\":0}",
        prefix: true,
      },
    ],
    report: [
      {
        id: "report-prefix-1",
        input: "add=12;sub=24;add=12",
        expected: "balance=24;accepted=2;rejected=1",
        prefix: true,
      },
      {
        id: "report-prefix-2",
        input: "sub=2",
        expected: "balance=0;accepted=0;rejected=1",
        prefix: true,
      },
      {
        id: "report-prefix-3",
        input: "",
        expected: "balance=0;accepted=0;rejected=0",
        prefix: true,
      },
    ],
  },
  104729: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "add=8;sub=16;add=8",
        expected: "[[\"add\",8],[\"sub\",16],[\"add\",8]]",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "sub=2",
        expected: "[[\"sub\",2]]",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "",
        expected: "[]",
        prefix: true,
      },
    ],
    reduce: [
      {
        id: "reduce-prefix-1",
        input: "add=8;sub=16;add=8",
        expected: "{\"balance\":16,\"accepted\":2,\"rejected\":1}",
        prefix: true,
      },
      {
        id: "reduce-prefix-2",
        input: "sub=2",
        expected: "{\"balance\":0,\"accepted\":0,\"rejected\":1}",
        prefix: true,
      },
      {
        id: "reduce-prefix-3",
        input: "",
        expected: "{\"balance\":0,\"accepted\":0,\"rejected\":0}",
        prefix: true,
      },
    ],
    report: [
      {
        id: "report-prefix-1",
        input: "add=8;sub=16;add=8",
        expected: "balance=16;accepted=2;rejected=1",
        prefix: true,
      },
      {
        id: "report-prefix-2",
        input: "sub=2",
        expected: "balance=0;accepted=0;rejected=1",
        prefix: true,
      },
      {
        id: "report-prefix-3",
        input: "",
        expected: "balance=0;accepted=0;rejected=0",
        prefix: true,
      },
    ],
  },
  8675309: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "add=4;sub=8;add=4",
        expected: "[[\"add\",4],[\"sub\",8],[\"add\",4]]",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "sub=2",
        expected: "[[\"sub\",2]]",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "",
        expected: "[]",
        prefix: true,
      },
    ],
    reduce: [
      {
        id: "reduce-prefix-1",
        input: "add=4;sub=8;add=4",
        expected: "{\"balance\":8,\"accepted\":2,\"rejected\":1}",
        prefix: true,
      },
      {
        id: "reduce-prefix-2",
        input: "sub=2",
        expected: "{\"balance\":0,\"accepted\":0,\"rejected\":1}",
        prefix: true,
      },
      {
        id: "reduce-prefix-3",
        input: "",
        expected: "{\"balance\":0,\"accepted\":0,\"rejected\":0}",
        prefix: true,
      },
    ],
    report: [
      {
        id: "report-prefix-1",
        input: "add=4;sub=8;add=4",
        expected: "balance=8;accepted=2;rejected=1",
        prefix: true,
      },
      {
        id: "report-prefix-2",
        input: "sub=2",
        expected: "balance=0;accepted=0;rejected=1",
        prefix: true,
      },
      {
        id: "report-prefix-3",
        input: "",
        expected: "balance=0;accepted=0;rejected=0",
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
  return { taskId: "ts-balance-reducer", ...seedValues(seed) };
}
