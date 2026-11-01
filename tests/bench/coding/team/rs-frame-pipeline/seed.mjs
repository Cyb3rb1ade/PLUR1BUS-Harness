// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  decode: [
    ["__TAGLEN__:__TAG__", "__TAG__"],
    ["2:Ä", "Ä"],
    ["0:", ""],
    ["1:Ä", "error"],
    ["1:\u0000", "error"],
  ],
  normalize: [
    ["  __TAG__  ", "__TAG__"],
    [" ÄÖ ", "äö"],
    ["", ""],
    ["AbC", "abc"],
    ["x\u0000y", "error"],
  ],
  encode: [
    ["__TAG__", "__TAGLEN__:__TAG__"],
    ["ä", "2:ä"],
    ["", "0:"],
    ["abc", "3:abc"],
    ["x\u0000y", "error"],
  ],
  e2e: [
    ["__TAGLEN__:__TAG__", "__TAGLEN__:__TAG__"],
    ["5: ABC ", "3:abc"],
    ["2:Ä", "2:ä"],
    ["0:", "0:"],
    ["1:\u0000", "error"],
  ],
};
const PREFIX = {
  17: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "13:item_4523540f",
        expected: "item_4523540f",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "5: ABC ",
        expected: " ABC ",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "2:Ä",
        expected: "Ä",
        prefix: true,
      },
      {
        id: "decode-prefix-4",
        input: "0:",
        expected: "",
        prefix: true,
      },
    ],
    normalize: [
      {
        id: "normalize-prefix-1",
        input: "13:item_4523540f",
        expected: "item_4523540f",
        prefix: true,
      },
      {
        id: "normalize-prefix-2",
        input: "5: ABC ",
        expected: "abc",
        prefix: true,
      },
      {
        id: "normalize-prefix-3",
        input: "2:Ä",
        expected: "ä",
        prefix: true,
      },
      {
        id: "normalize-prefix-4",
        input: "0:",
        expected: "",
        prefix: true,
      },
    ],
    encode: [
      {
        id: "encode-prefix-1",
        input: "13:item_4523540f",
        expected: "13:item_4523540f",
        prefix: true,
      },
      {
        id: "encode-prefix-2",
        input: "5: ABC ",
        expected: "3:abc",
        prefix: true,
      },
      {
        id: "encode-prefix-3",
        input: "2:Ä",
        expected: "2:ä",
        prefix: true,
      },
      {
        id: "encode-prefix-4",
        input: "0:",
        expected: "0:",
        prefix: true,
      },
    ],
  },
  104729: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "13:item_3893c027",
        expected: "item_3893c027",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "5: ABC ",
        expected: " ABC ",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "2:Ä",
        expected: "Ä",
        prefix: true,
      },
      {
        id: "decode-prefix-4",
        input: "0:",
        expected: "",
        prefix: true,
      },
    ],
    normalize: [
      {
        id: "normalize-prefix-1",
        input: "13:item_3893c027",
        expected: "item_3893c027",
        prefix: true,
      },
      {
        id: "normalize-prefix-2",
        input: "5: ABC ",
        expected: "abc",
        prefix: true,
      },
      {
        id: "normalize-prefix-3",
        input: "2:Ä",
        expected: "ä",
        prefix: true,
      },
      {
        id: "normalize-prefix-4",
        input: "0:",
        expected: "",
        prefix: true,
      },
    ],
    encode: [
      {
        id: "encode-prefix-1",
        input: "13:item_3893c027",
        expected: "13:item_3893c027",
        prefix: true,
      },
      {
        id: "encode-prefix-2",
        input: "5: ABC ",
        expected: "3:abc",
        prefix: true,
      },
      {
        id: "encode-prefix-3",
        input: "2:Ä",
        expected: "2:ä",
        prefix: true,
      },
      {
        id: "encode-prefix-4",
        input: "0:",
        expected: "0:",
        prefix: true,
      },
    ],
  },
  8675309: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "13:item_37ba3881",
        expected: "item_37ba3881",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "5: ABC ",
        expected: " ABC ",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "2:Ä",
        expected: "Ä",
        prefix: true,
      },
      {
        id: "decode-prefix-4",
        input: "0:",
        expected: "",
        prefix: true,
      },
    ],
    normalize: [
      {
        id: "normalize-prefix-1",
        input: "13:item_37ba3881",
        expected: "item_37ba3881",
        prefix: true,
      },
      {
        id: "normalize-prefix-2",
        input: "5: ABC ",
        expected: "abc",
        prefix: true,
      },
      {
        id: "normalize-prefix-3",
        input: "2:Ä",
        expected: "ä",
        prefix: true,
      },
      {
        id: "normalize-prefix-4",
        input: "0:",
        expected: "",
        prefix: true,
      },
    ],
    encode: [
      {
        id: "encode-prefix-1",
        input: "13:item_37ba3881",
        expected: "13:item_37ba3881",
        prefix: true,
      },
      {
        id: "encode-prefix-2",
        input: "5: ABC ",
        expected: "3:abc",
        prefix: true,
      },
      {
        id: "encode-prefix-3",
        input: "2:Ä",
        expected: "2:ä",
        prefix: true,
      },
      {
        id: "encode-prefix-4",
        input: "0:",
        expected: "0:",
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
  return { taskId: "rs-frame-pipeline", ...seedValues(seed) };
}
