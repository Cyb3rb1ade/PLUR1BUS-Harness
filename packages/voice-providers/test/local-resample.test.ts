import { test } from "node:test";
import assert from "node:assert/strict";
import { resample } from "../src/local/providers.ts";

function tone(freq: number, rate: number, seconds = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5;
  return out;
}
/** RMS of the middle half, away from the edge effects. */
function rms(x: Float32Array): number {
  const a = Math.floor(x.length / 4);
  const b = Math.floor((x.length * 3) / 4);
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (b - a));
}
const db = (a: number, b: number) => 20 * Math.log10(a / b);
function linear(samples: Float32Array, from: number, to: number): Float32Array {
  const n = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = samples[i0]! + (samples[i1]! - samples[i0]!) * (pos - i0);
  }
  return out;
}

test("downsampling 24 -> 16 kHz low-passes: a 9 kHz tone (aliases to 7 kHz without a filter) is attenuated by more than 12 dB versus linear interpolation", () => {
  // The brief's example named 7 kHz, which lies below the new 8 kHz Nyquist and does not alias; 9 kHz does.
  const x = tone(9000, 24000);
  const filtered = rms(resample(x, 24000, 16000));
  const naive = rms(linear(x, 24000, 16000));
  assert.ok(db(naive, filtered) > 12, `attenuation ${db(naive, filtered).toFixed(1)} dB`);
});

test("speech-band content passes: a 1 kHz tone keeps its level within 1 dB, DC is preserved, lengths match the ratio", () => {
  const x = tone(1000, 24000);
  const y = resample(x, 24000, 16000);
  assert.equal(y.length, Math.round((x.length * 16000) / 24000));
  assert.ok(Math.abs(db(rms(y), rms(x))) < 1);
  const dc = resample(new Float32Array(2400).fill(0.25), 24000, 16000);
  assert.ok(dc.every((v) => Math.abs(v - 0.25) < 1e-4));
});

test("upsampling stays linear and identity returns the input", () => {
  const x = tone(500, 16000, 0.1);
  assert.equal(resample(x, 16000, 16000), x);
  const up = resample(x, 16000, 24000);
  assert.equal(up.length, Math.round((x.length * 24000) / 16000));
  assert.ok(Math.abs(db(rms(up), rms(x))) < 0.5);
  assert.equal(resample(new Float32Array(0), 24000, 16000).length, 0);
});
