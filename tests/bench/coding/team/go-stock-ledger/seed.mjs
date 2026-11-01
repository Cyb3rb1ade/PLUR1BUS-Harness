// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  decode: [
    ["ADD __TAG__ __N__;RESERVE __TAG__ __N2__", "A,__TAG__,__N__;R,__TAG__,__N2__"],
    ["", ""],
    ["ADD a 0", "error"],
    ["REMOVE a 1", "error"],
    ["ADD bad-name 1", "error"],
    ["ADD a 1 extra", "error"],
  ],
  apply: [
    ["A,__TAG__,__N__;R,__TAG__,__N2__;A,__TAG__,__N__", "__TAG__:__N2__"],
    ["R,a,1", ""],
    ["A,a,1;R,a,1", "a:0"],
    ["X,a,1", "error"],
    ["A,bad-name,1", "error"],
    ["A,a,1,extra", "error"],
  ],
  render: [
    ["__TAG__:__N__;z:__N2__", "skus=2;available=__N3__"],
    ["a:0", "skus=1;available=0"],
    ["", "skus=0;available=0"],
    ["a:1;a:2", "error"],
    ["bad-name:1", "error"],
    ["a:1:2", "error"],
  ],
  e2e: [
    ["ADD __TAG__ __N__;RESERVE __TAG__ __N2__;ADD __TAG__ __N__", "skus=1;available=__N2__"],
    ["RESERVE a 1", "skus=0;available=0"],
    ["ADD a 1;RESERVE a 1", "skus=1;available=0"],
  ],
};
const PREFIX = {
  17: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "ADD item_4523540f 12;RESERVE item_4523540f 24;ADD item_4523540f 12",
        expected: "A,item_4523540f,12;R,item_4523540f,24;A,item_4523540f,12",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "RESERVE a 1",
        expected: "R,a,1",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "A,a,1;R,a,1",
        prefix: true,
      },
    ],
    apply: [
      {
        id: "apply-prefix-1",
        input: "ADD item_4523540f 12;RESERVE item_4523540f 24;ADD item_4523540f 12",
        expected: "item_4523540f:24",
        prefix: true,
      },
      {
        id: "apply-prefix-2",
        input: "RESERVE a 1",
        expected: "",
        prefix: true,
      },
      {
        id: "apply-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "a:0",
        prefix: true,
      },
    ],
    render: [
      {
        id: "render-prefix-1",
        input: "ADD item_4523540f 12;RESERVE item_4523540f 24;ADD item_4523540f 12",
        expected: "skus=1;available=24",
        prefix: true,
      },
      {
        id: "render-prefix-2",
        input: "RESERVE a 1",
        expected: "skus=0;available=0",
        prefix: true,
      },
      {
        id: "render-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "skus=1;available=0",
        prefix: true,
      },
    ],
  },
  104729: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "ADD item_3893c027 8;RESERVE item_3893c027 16;ADD item_3893c027 8",
        expected: "A,item_3893c027,8;R,item_3893c027,16;A,item_3893c027,8",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "RESERVE a 1",
        expected: "R,a,1",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "A,a,1;R,a,1",
        prefix: true,
      },
    ],
    apply: [
      {
        id: "apply-prefix-1",
        input: "ADD item_3893c027 8;RESERVE item_3893c027 16;ADD item_3893c027 8",
        expected: "item_3893c027:16",
        prefix: true,
      },
      {
        id: "apply-prefix-2",
        input: "RESERVE a 1",
        expected: "",
        prefix: true,
      },
      {
        id: "apply-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "a:0",
        prefix: true,
      },
    ],
    render: [
      {
        id: "render-prefix-1",
        input: "ADD item_3893c027 8;RESERVE item_3893c027 16;ADD item_3893c027 8",
        expected: "skus=1;available=16",
        prefix: true,
      },
      {
        id: "render-prefix-2",
        input: "RESERVE a 1",
        expected: "skus=0;available=0",
        prefix: true,
      },
      {
        id: "render-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "skus=1;available=0",
        prefix: true,
      },
    ],
  },
  8675309: {
    decode: [
      {
        id: "decode-prefix-1",
        input: "ADD item_37ba3881 4;RESERVE item_37ba3881 8;ADD item_37ba3881 4",
        expected: "A,item_37ba3881,4;R,item_37ba3881,8;A,item_37ba3881,4",
        prefix: true,
      },
      {
        id: "decode-prefix-2",
        input: "RESERVE a 1",
        expected: "R,a,1",
        prefix: true,
      },
      {
        id: "decode-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "A,a,1;R,a,1",
        prefix: true,
      },
    ],
    apply: [
      {
        id: "apply-prefix-1",
        input: "ADD item_37ba3881 4;RESERVE item_37ba3881 8;ADD item_37ba3881 4",
        expected: "item_37ba3881:8",
        prefix: true,
      },
      {
        id: "apply-prefix-2",
        input: "RESERVE a 1",
        expected: "",
        prefix: true,
      },
      {
        id: "apply-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "a:0",
        prefix: true,
      },
    ],
    render: [
      {
        id: "render-prefix-1",
        input: "ADD item_37ba3881 4;RESERVE item_37ba3881 8;ADD item_37ba3881 4",
        expected: "skus=1;available=8",
        prefix: true,
      },
      {
        id: "render-prefix-2",
        input: "RESERVE a 1",
        expected: "skus=0;available=0",
        prefix: true,
      },
      {
        id: "render-prefix-3",
        input: "ADD a 1;RESERVE a 1",
        expected: "skus=1;available=0",
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
  return { taskId: "go-stock-ledger", ...seedValues(seed) };
}
