// SPDX-License-Identifier: MIT
import { expandCases, seedValues } from "../_shared/seed.mjs";
const TEMPLATE = {
  "split": [
    [
      "HTTPS://Example.Test:443/__TAG__?n=__N__#x",
      "{\"scheme\":\"https\",\"host\":\"example.test\",\"port\":443,\"path\":\"/__TAG__\",\"query\":\"n=__N__\"}"
    ],
    [
      "http://a.test",
      "{\"scheme\":\"http\",\"host\":\"a.test\",\"port\":null,\"path\":\"/\",\"query\":\"\"}"
    ],
    [
      "file:///x",
      "error"
    ],
    [
      "http://user@a.test",
      "error"
    ]
  ],
  "normalize": [
    [
      "{\"scheme\":\"https\",\"host\":\"example.test\",\"port\":443,\"path\":\"/a/../__TAG__\",\"query\":\"z=2&a=1\"}",
      "{\"scheme\":\"https\",\"host\":\"example.test\",\"port\":null,\"path\":\"/__TAG__\",\"query\":\"a=1&z=2\"}"
    ],
    [
      "{\"scheme\":\"http\",\"host\":\"a.test\",\"port\":8080,\"path\":\"/a%20b\",\"query\":\"a=\"}",
      "{\"scheme\":\"http\",\"host\":\"a.test\",\"port\":8080,\"path\":\"/a%20b\",\"query\":\"a=\"}"
    ],
    [
      "[]",
      "error"
    ]
  ],
  "assemble": [
    [
      "{\"scheme\":\"https\",\"host\":\"a.test\",\"port\":null,\"path\":\"/__TAG__\",\"query\":\"n=__N__\"}",
      "https://a.test/__TAG__?n=__N__"
    ],
    [
      "{\"scheme\":\"http\",\"host\":\"a.test\",\"port\":8080,\"path\":\"/\",\"query\":\"\"}",
      "http://a.test:8080/"
    ],
    [
      "{}",
      "error"
    ]
  ],
  "e2e": [
    [
      "HTTPS://Example.Test:443/a/../__TAG__?z=2&a=1#x",
      "https://example.test/__TAG__?a=1&z=2"
    ],
    [
      "http://a.test:80/a%20b?q=hello+world",
      "http://a.test/a%20b?q=hello+world"
    ],
    [
      "https://a.test",
      "https://a.test/"
    ]
  ]
};
export function casesForSeed(seed) { return expandCases(TEMPLATE, seed); }
export function instanceForSeed(seed) { return { taskId: 'py-url-pipeline', ...seedValues(seed) }; }
