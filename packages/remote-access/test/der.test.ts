import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bitString, bool, ctx, ctxPrimitive, children, integerFromBytes, integerFromNumber, nul, octets, oid, readTlv, seq, set, time, tlv, utf8,
} from "../src/der.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("lengths: short form, then 1, 2 and 3 length octets", () => {
  assert.equal(hex(seq()), "3000");
  assert.equal(hex(tlv(0x04, new Uint8Array(127))).slice(0, 6), "047f00");
  assert.equal(hex(tlv(0x04, new Uint8Array(128))).slice(0, 8), "04818000");
  assert.equal(hex(tlv(0x04, new Uint8Array(256))).slice(0, 10), "0482010000");
  assert.equal(hex(tlv(0x04, new Uint8Array(65536))).slice(0, 12), "048301000000");
});

test("OBJECT IDENTIFIER encoding matches known values", () => {
  assert.equal(hex(oid("2.5.29.17")), "0603551d11");
  assert.equal(hex(oid("1.2.840.10045.4.3.2")), "06082a8648ce3d040302");
  assert.equal(hex(oid("1.2.840.113549.1.1.11")), "06092a864886f70d01010b");
  assert.equal(hex(oid("1.3.6.1.5.5.7.3.1")), "06082b06010505070301");
  assert.throws(() => oid("1"), /oid/i);
  assert.throws(() => oid("3.1.1"), /oid/i);
  assert.throws(() => oid("1.x"), /oid/i);
});

test("INTEGER is minimal and non-negative", () => {
  assert.equal(hex(integerFromNumber(0)), "020100");
  assert.equal(hex(integerFromNumber(127)), "02017f");
  assert.equal(hex(integerFromNumber(128)), "02020080");
  assert.equal(hex(integerFromNumber(256)), "02020100");
  assert.equal(hex(integerFromBytes(Uint8Array.from([0, 0, 0x81]))), "02020081");
  assert.equal(hex(integerFromBytes(Uint8Array.from([0x7f]))), "02017f");
  assert.equal(hex(integerFromBytes(Uint8Array.from([0, 0]))), "020100");
  assert.throws(() => integerFromNumber(-1), /integer/i);
  assert.throws(() => integerFromBytes(new Uint8Array(0)), /integer/i);
});

test("BOOLEAN, NULL, OCTET STRING, BIT STRING, UTF8String, SET, context tags", () => {
  assert.equal(hex(bool(true)), "0101ff");
  assert.equal(hex(bool(false)), "010100");
  assert.equal(hex(nul()), "0500");
  assert.equal(hex(octets(Uint8Array.from([1, 2]))), "04020102");
  assert.equal(hex(bitString(Uint8Array.from([0x80]), 7)), "03020780");
  assert.equal(hex(utf8("é")), "0c02c3a9");
  assert.equal(hex(set(nul())), "31020500");
  assert.equal(hex(ctx(0, integerFromNumber(2))), "a003020102");
  assert.equal(hex(ctxPrimitive(2, Buffer.from("abc"))), "8203616263");
  assert.throws(() => bitString(Uint8Array.from([0]), 8), /unused/i);
});

test("time(): UTCTime in 1950..2049, GeneralizedTime outside, UTC only", () => {
  assert.equal(hex(time(new Date(Date.UTC(2026, 9, 8, 12, 30, 45)))), "170d3236313030383132333034355a");
  assert.equal(Buffer.from(time(new Date(Date.UTC(2050, 0, 1)))).toString("latin1"), "\x18\x0f20500101000000Z");
  assert.equal(Buffer.from(time(new Date(Date.UTC(1949, 11, 31, 23, 59, 59)))).toString("latin1"), "\x18\x0f19491231235959Z");
  assert.throws(() => time(new Date(NaN)), /date/i);
});

test("reader: walks a structure it built, rejects truncated and indefinite encodings", () => {
  const big = new Uint8Array(300).fill(7);
  const der = seq(integerFromNumber(5), tlv(0x04, big), ctx(3, seq()));
  const top = readTlv(der, 0);
  assert.equal(top.tag, 0x30);
  assert.equal(top.end, der.length);
  const kids = children(der.subarray(top.start, top.end));
  assert.deepEqual(kids.map((k) => k.tag), [0x02, 0x04, 0xa3]);
  assert.equal(kids[1]!.end - kids[1]!.start, 300);
  assert.throws(() => readTlv(Uint8Array.from([0x30, 0x05, 0x01]), 0), /truncated/i);
  assert.throws(() => readTlv(Uint8Array.from([0x30, 0x80, 0x00, 0x00]), 0), /indefinite/i);
  assert.throws(() => readTlv(Uint8Array.from([0x30]), 0), /truncated/i);
  assert.throws(() => readTlv(Uint8Array.from([0x1f, 0x01, 0x00]), 0), /tag/i);
});
