// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  decode: [
    ["__N__.00@1900", "__N100__@1900"],
    ["-0.00@0", "0@0"],
    ["1.2@0", "error"],
    ["1.00@10001", "error"],
  ],
  tax: [
    ["__N100__@1900", "__N119__"],
    ["1@5000", "2"],
    ["-1@5000", "-2"],
    ["0@0", "0"],
    ["1@-1", "error"],
  ],
  format: [
    ["__N119__", "__N119EUR__ EUR"],
    ["-1", "-0.01 EUR"],
    ["0", "0.00 EUR"],
    ["1.2", "error"],
  ],
  e2e: [
    ["__N__.00@1900", "__N119EUR__ EUR"],
    ["-0.01@5000", "-0.02 EUR"],
    ["0.00@0", "0.00 EUR"],
  ],
};
const PREFIX = {
  17: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "12.00@1900",
        expected: "1200@1900",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "-0.01@5000",
        expected: "-1@5000",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "0.00@0",
        expected: "0@0",
        prefix: true,
      },
    ],
    tax: [
      {
        id: "tax-prefix-1",
        input: "12.00@1900",
        expected: "1428",
        prefix: true,
      },
      {
        id: "tax-prefix-2",
        input: "-0.01@5000",
        expected: "-2",
        prefix: true,
      },
      {
        id: "tax-prefix-3",
        input: "0.00@0",
        expected: "0",
        prefix: true,
      },
    ],
    format: [
      {
        id: "format-prefix-1",
        input: "12.00@1900",
        expected: "14.28 EUR",
        prefix: true,
      },
      {
        id: "format-prefix-2",
        input: "-0.01@5000",
        expected: "-0.02 EUR",
        prefix: true,
      },
      {
        id: "format-prefix-3",
        input: "0.00@0",
        expected: "0.00 EUR",
        prefix: true,
      },
    ],
  },
  104729: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "8.00@1900",
        expected: "800@1900",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "-0.01@5000",
        expected: "-1@5000",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "0.00@0",
        expected: "0@0",
        prefix: true,
      },
    ],
    tax: [
      {
        id: "tax-prefix-1",
        input: "8.00@1900",
        expected: "952",
        prefix: true,
      },
      {
        id: "tax-prefix-2",
        input: "-0.01@5000",
        expected: "-2",
        prefix: true,
      },
      {
        id: "tax-prefix-3",
        input: "0.00@0",
        expected: "0",
        prefix: true,
      },
    ],
    format: [
      {
        id: "format-prefix-1",
        input: "8.00@1900",
        expected: "9.52 EUR",
        prefix: true,
      },
      {
        id: "format-prefix-2",
        input: "-0.01@5000",
        expected: "-0.02 EUR",
        prefix: true,
      },
      {
        id: "format-prefix-3",
        input: "0.00@0",
        expected: "0.00 EUR",
        prefix: true,
      },
    ],
  },
  8675309: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "4.00@1900",
        expected: "400@1900",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "-0.01@5000",
        expected: "-1@5000",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "0.00@0",
        expected: "0@0",
        prefix: true,
      },
    ],
    tax: [
      {
        id: "tax-prefix-1",
        input: "4.00@1900",
        expected: "476",
        prefix: true,
      },
      {
        id: "tax-prefix-2",
        input: "-0.01@5000",
        expected: "-2",
        prefix: true,
      },
      {
        id: "tax-prefix-3",
        input: "0.00@0",
        expected: "0",
        prefix: true,
      },
    ],
    format: [
      {
        id: "format-prefix-1",
        input: "4.00@1900",
        expected: "4.76 EUR",
        prefix: true,
      },
      {
        id: "format-prefix-2",
        input: "-0.01@5000",
        expected: "-0.02 EUR",
        prefix: true,
      },
      {
        id: "format-prefix-3",
        input: "0.00@0",
        expected: "0.00 EUR",
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
  return { taskId: "py-money-pipeline", ...seedValues(seed) };
}
