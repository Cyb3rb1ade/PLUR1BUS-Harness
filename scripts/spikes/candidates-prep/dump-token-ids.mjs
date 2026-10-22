// Dumps the token-id sequences the JS candidate runner builds, for parity checks against the python tokenizers.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildCappedInputs, specialTokenNames } from '../decision-laya-candidates.mjs';
// usage: node dump-token-ids.mjs MODEL_DIR RUNTIME_PACKAGE_JSON [MAX_TOKENS] > ids.json   (feeds verify_multilingual_onnx.py)
const [dir, runtimePackage, cap] = [process.argv[2], process.argv[3], process.argv[4] ? Number(process.argv[4]) : undefined];
const require = createRequire(runtimePackage);
const { PreTrainedTokenizer } = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);
const j = async f => JSON.parse(await readFile(join(dir, f), 'utf8'));
const tc = await j('tokenizer/tokenizer_config.json');
const tk = new PreTrainedTokenizer(await j('tokenizer/tokenizer.json'), tc);
const names = specialTokenNames(tc), raw = tk._tokenizer;
const tok = { encode: t => tk.encode(t, { add_special_tokens: false }), cls: raw.token_to_id(names.cls), sep: raw.token_to_id(names.sep), mask: raw.token_to_id(names.mask) };
const config = await j('rl_agent_config.json');
const fx = JSON.parse(await readFile(new URL('../decision-eval-cases.json', import.meta.url), 'utf8'));
const out = { special: [tok.cls, tok.sep, tok.mask], rows: {} };
for (const row of fx.cases) for (const l of ['de', 'en']) {
  const req = { primitive: row.primitive, question: row.question[l], state: row.state[l], options: row.options.map(o => ({ id: o.id, description: o.description[l] })) };
  try { const r = buildCappedInputs(req, tok, config, cap); out.rows[`${row.id}:${l}`] = { ids: r.ids, positions: r.positions, primitive: row.primitive }; } catch (e) { out.rows[`${row.id}:${l}`] = { error: e.message }; }
}
console.log(JSON.stringify(out));
