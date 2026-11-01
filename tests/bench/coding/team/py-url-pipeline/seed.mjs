// SPDX-License-Identifier: MIT
/** Host-only semantic oracle; no fixture code or expected output is materialized. */
import { checkedCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  split: [
    [
      "HTTPS://Example.Test:443/__TAG__?n=__N__#x",
      '{"scheme":"https","host":"example.test","port":443,"path":"/__TAG__","query":"n=__N__"}',
    ],
    ["http://a.test", '{"scheme":"http","host":"a.test","port":null,"path":"/","query":""}'],
    ["file:///x", "error"],
    ["http://user@a.test", "error"],
  ],
  normalize: [
    [
      '{"scheme":"https","host":"example.test","port":443,"path":"/a/../__TAG__","query":"z=2&a=1"}',
      '{"scheme":"https","host":"example.test","port":null,"path":"/__TAG__","query":"a=1&z=2"}',
    ],
    [
      '{"scheme":"http","host":"a.test","port":8080,"path":"/a%20b","query":"a="}',
      '{"scheme":"http","host":"a.test","port":8080,"path":"/a%20b","query":"a="}',
    ],
    ["[]", "error"],
  ],
  assemble: [
    [
      '{"scheme":"https","host":"a.test","port":null,"path":"/__TAG__","query":"n=__N__"}',
      "https://a.test/__TAG__?n=__N__",
    ],
    ['{"scheme":"http","host":"a.test","port":8080,"path":"/","query":""}', "http://a.test:8080/"],
    ["{}", "error"],
  ],
  e2e: [
    ["HTTPS://Example.Test:443/a/../__TAG__?z=2&a=1#x", "https://example.test/__TAG__?a=1&z=2"],
    ["http://a.test:80/a%20b?q=hello+world", "http://a.test/a%20b?q=hello+world"],
    ["https://a.test", "https://a.test/"],
  ],
};
const PREFIX = {
  17: {
    split: [
      {
        id: "split-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_4523540f?z=2&a=1#x",
        expected: '{"scheme":"https","host":"example.test","port":443,"path":"/a/../item_4523540f","query":"z=2&a=1"}',
        prefix: true,
      },
      {
        id: "split-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: '{"scheme":"http","host":"a.test","port":80,"path":"/a%20b","query":"q=hello+world"}',
        prefix: true,
      },
      {
        id: "split-prefix-3",
        input: "https://a.test",
        expected: '{"scheme":"https","host":"a.test","port":null,"path":"/","query":""}',
        prefix: true,
      },
    ],
    normalize: [
      {
        id: "normalize-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_4523540f?z=2&a=1#x",
        expected: '{"scheme":"https","host":"example.test","port":null,"path":"/item_4523540f","query":"a=1&z=2"}',
        prefix: true,
      },
      {
        id: "normalize-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: '{"scheme":"http","host":"a.test","port":null,"path":"/a%20b","query":"q=hello+world"}',
        prefix: true,
      },
      {
        id: "normalize-prefix-3",
        input: "https://a.test",
        expected: '{"scheme":"https","host":"a.test","port":null,"path":"/","query":""}',
        prefix: true,
      },
    ],
    assemble: [
      {
        id: "assemble-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_4523540f?z=2&a=1#x",
        expected: "https://example.test/item_4523540f?a=1&z=2",
        prefix: true,
      },
      {
        id: "assemble-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: "http://a.test/a%20b?q=hello+world",
        prefix: true,
      },
      {
        id: "assemble-prefix-3",
        input: "https://a.test",
        expected: "https://a.test/",
        prefix: true,
      },
    ],
  },
  104729: {
    split: [
      {
        id: "split-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_3893c027?z=2&a=1#x",
        expected: '{"scheme":"https","host":"example.test","port":443,"path":"/a/../item_3893c027","query":"z=2&a=1"}',
        prefix: true,
      },
      {
        id: "split-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: '{"scheme":"http","host":"a.test","port":80,"path":"/a%20b","query":"q=hello+world"}',
        prefix: true,
      },
      {
        id: "split-prefix-3",
        input: "https://a.test",
        expected: '{"scheme":"https","host":"a.test","port":null,"path":"/","query":""}',
        prefix: true,
      },
    ],
    normalize: [
      {
        id: "normalize-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_3893c027?z=2&a=1#x",
        expected: '{"scheme":"https","host":"example.test","port":null,"path":"/item_3893c027","query":"a=1&z=2"}',
        prefix: true,
      },
      {
        id: "normalize-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: '{"scheme":"http","host":"a.test","port":null,"path":"/a%20b","query":"q=hello+world"}',
        prefix: true,
      },
      {
        id: "normalize-prefix-3",
        input: "https://a.test",
        expected: '{"scheme":"https","host":"a.test","port":null,"path":"/","query":""}',
        prefix: true,
      },
    ],
    assemble: [
      {
        id: "assemble-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_3893c027?z=2&a=1#x",
        expected: "https://example.test/item_3893c027?a=1&z=2",
        prefix: true,
      },
      {
        id: "assemble-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: "http://a.test/a%20b?q=hello+world",
        prefix: true,
      },
      {
        id: "assemble-prefix-3",
        input: "https://a.test",
        expected: "https://a.test/",
        prefix: true,
      },
    ],
  },
  8675309: {
    split: [
      {
        id: "split-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_37ba3881?z=2&a=1#x",
        expected: '{"scheme":"https","host":"example.test","port":443,"path":"/a/../item_37ba3881","query":"z=2&a=1"}',
        prefix: true,
      },
      {
        id: "split-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: '{"scheme":"http","host":"a.test","port":80,"path":"/a%20b","query":"q=hello+world"}',
        prefix: true,
      },
      {
        id: "split-prefix-3",
        input: "https://a.test",
        expected: '{"scheme":"https","host":"a.test","port":null,"path":"/","query":""}',
        prefix: true,
      },
    ],
    normalize: [
      {
        id: "normalize-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_37ba3881?z=2&a=1#x",
        expected: '{"scheme":"https","host":"example.test","port":null,"path":"/item_37ba3881","query":"a=1&z=2"}',
        prefix: true,
      },
      {
        id: "normalize-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: '{"scheme":"http","host":"a.test","port":null,"path":"/a%20b","query":"q=hello+world"}',
        prefix: true,
      },
      {
        id: "normalize-prefix-3",
        input: "https://a.test",
        expected: '{"scheme":"https","host":"a.test","port":null,"path":"/","query":""}',
        prefix: true,
      },
    ],
    assemble: [
      {
        id: "assemble-prefix-1",
        input: "HTTPS://Example.Test:443/a/../item_37ba3881?z=2&a=1#x",
        expected: "https://example.test/item_37ba3881?a=1&z=2",
        prefix: true,
      },
      {
        id: "assemble-prefix-2",
        input: "http://a.test:80/a%20b?q=hello+world",
        expected: "http://a.test/a%20b?q=hello+world",
        prefix: true,
      },
      {
        id: "assemble-prefix-3",
        input: "https://a.test",
        expected: "https://a.test/",
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
  return { taskId: "py-url-pipeline", ...seedValues(seed) };
}
