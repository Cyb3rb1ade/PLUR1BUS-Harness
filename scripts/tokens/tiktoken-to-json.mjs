/** Converts pinned o200k ranks to a deterministic, raw-text Hugging Face tokenizer (RE-14/T2, RE-D25).
 * No vocabulary is bundled. Regex pieces and byte-level IDs follow OpenAI tiktoken's o200k_base contract.
 */

const O200K_PATTERN = [
  String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
  String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
  String.raw`\p{N}{1,3}`,
  String.raw` ?[^\s\p{L}\p{N}]+[\r\n/]*`,
  String.raw`\s*[\r\n]+`,
  String.raw`\s+(?!\S)`,
  String.raw`\s+`,
].join("|");

function byteAlphabet() {
  const visible = Array.from({ length: 256 }, (_, byte) => byte)
    .filter((byte) => byte >= 33 && byte <= 126 || byte >= 161 && byte <= 172 || byte >= 174);
  const alphabet = new Map(visible.map((byte) => [byte, String.fromCodePoint(byte)]));
  let next = 256;
  for (let byte = 0; byte < 256; byte++) {
    if (!alphabet.has(byte)) alphabet.set(byte, String.fromCodePoint(next++));
  }
  return alphabet;
}

function parseRanks(text) {
  const alphabet = byteAlphabet();
  const byBytes = new Map();
  const byRank = new Map();
  for (const [index, line] of text.trimEnd().split(/\r?\n/).entries()) {
    const match = /^([A-Za-z0-9+/]+={0,2}) ([0-9]+)$/.exec(line);
    if (!match) throw new Error(`Invalid rank line ${index + 1}`);
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.toString("base64") !== match[1]) throw new Error(`Noncanonical base64 at line ${index + 1}`);
    const rank = Number(match[2]);
    if (!Number.isSafeInteger(rank) || rank > 0xffff_ffff) throw new Error(`Invalid rank at line ${index + 1}`);
    if (byBytes.has(match[1])) throw new Error(`Duplicate token at line ${index + 1}`);
    if (byRank.has(rank)) throw new Error(`Duplicate rank at line ${index + 1}`);
    const token = { bytes, rank, value: Array.from(bytes, (byte) => alphabet.get(byte)).join("") };
    byBytes.set(match[1], token);
    byRank.set(rank, token);
  }
  const tokens = [...byRank.values()].sort((left, right) => left.rank - right.rank);
  if (tokens.some((token, index) => token.rank !== index)) throw new Error("Ranks must be contiguous from zero");
  for (let byte = 0; byte < 256; byte++) {
    if (!byBytes.has(Buffer.from([byte]).toString("base64"))) throw new Error(`Missing base byte ${byte}`);
  }
  return { tokens, byBytes };
}

/** Return canonical tokenizer.json bytes as UTF-8 text; invalid or incomplete rank tables throw. */
export function convertTiktokenToJson(rankText) {
  const { tokens, byBytes } = parseRanks(rankText);
  const merges = [];
  for (const { bytes } of tokens) {
    const candidates = [];
    for (let index = 1; index < bytes.length; index++) {
      const left = byBytes.get(bytes.subarray(0, index).toString("base64"));
      const right = byBytes.get(bytes.subarray(index).toString("base64"));
      if (left && right) candidates.push([left, right]);
    }
    // Every split of a token is needed; result-rank order preserves tiktoken's merge priorities.
    candidates.sort(([leftA, rightA], [leftB, rightB]) => leftA.rank - leftB.rank || rightA.rank - rightB.rank);
    for (const [left, right] of candidates) merges.push([left.value, right.value]);
  }
  const byteLevel = { type: "ByteLevel", add_prefix_space: false, trim_offsets: false, use_regex: false };
  return JSON.stringify({
    version: "1.0", truncation: null, padding: null, added_tokens: [], normalizer: null,
    pre_tokenizer: {
      type: "Sequence",
      pretokenizers: [
        { type: "Split", pattern: { Regex: O200K_PATTERN }, behavior: "Isolated", invert: false },
        byteLevel,
      ],
    },
    post_processor: null,
    decoder: byteLevel,
    model: {
      type: "BPE", dropout: null, unk_token: null, continuing_subword_prefix: null, end_of_word_suffix: null,
      fuse_unk: false, byte_fallback: false, ignore_merges: true,
      vocab: Object.fromEntries(tokens.map(({ value, rank }) => [value, rank])), merges,
    },
  }) + "\n";
}
