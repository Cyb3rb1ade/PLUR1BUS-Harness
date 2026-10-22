# Offline preparation for the Linux x64 candidate comparison (2026-10-21). Not part of any build or CI path.
# Needs a throwaway virtualenv, never the repository lockfiles:
#   python3 -m venv VENV && VENV/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
#   VENV/bin/pip install onnx onnxruntime numpy safetensors tokenizers transformers onnxscript laya==0.4.12   # laya only for its DecisionModel class
# Versions used: torch 2.14.1+cpu, transformers 5.20.2, onnx 1.23.2, onnxruntime 1.31.0 (quantizer only), laya 0.4.12.
# Model files are written outside the repository and are never committed.
"""Parity: JS token ids == python tokenizers ids (same layout); ONNX (ORT python) logits == eager laya DecisionModel (fp32) on all 180 requests + a padded batch."""
import sys, os, json, numpy as np, torch, onnxruntime as ort
from tokenizers import Tokenizer
import laya.common as lc
from safetensors import safe_open
from transformers import AutoConfig, AutoModel
torch.set_grad_enabled(False)
src, onnxdir, IDS_JSON, FIXTURE_JSON = sys.argv[1:5]  # multilingual source dir, exported ONNX dir, JSON written by the candidate runner token dump, eval cases
js = json.load(open(IDS_JSON))
fx = json.load(open(FIXTURE_JSON))
tk = Tokenizer.from_file(os.path.join(src, 'tokenizer/tokenizer.json'))
cls, sep, mask = js['special']
assert tk.token_to_id('<bos>') == cls and tk.token_to_id('<eos>') == sep and tk.token_to_id('<mask>') == mask
enc = lambda t: tk.encode(t, add_special_tokens=False).ids
cfg = json.load(open(os.path.join(src, 'rl_agent_config.json')))
reqs = {}
mism = 0
for row in fx['cases']:
    for l in ('de', 'en'):
        ids = [cls] + enc(f"{row['primitive']} question: {row['question'][l]}") + [sep]; pos = []
        for o in row['options']:
            pos.append(len(ids)); ids += [mask] + enc(f" {o['id']}: {o['description'][l]}")
        ids += [sep] + enc(row['state'][l]) + [sep]
        j = js['rows'][f"{row['id']}:{l}"]
        if j['ids'] != ids or j['positions'] != pos: mism += 1
        reqs[f"{row['id']}:{l}"] = (ids, pos, {'choice': 0, 'score': 1, 'noul': 2}[row['primitive']])
print('token-id mismatches JS vs python tokenizers:', mism, 'of', len(reqs), flush=True)
ecfg = AutoConfig.from_pretrained(os.path.join(src, 'encoder')); lc._apply_rope_config(ecfg)
model = lc.DecisionModel(AutoModel.from_config(ecfg, attn_implementation='sdpa'), cfg['head_layers'], len(cfg['act_costs']) + 1)
sd = model.state_dict()
with safe_open(os.path.join(src, 'model.safetensors'), 'pt') as f:
    for k in f.keys(): sd[k].copy_(f.get_tensor(k).to(sd[k].dtype))
model = model.float().eval()
sess = ort.InferenceSession(os.path.join(onnxdir, 'model.onnx'), providers=['CPUExecutionProvider'])
def mk(items):
    n = len(items); L = max(len(i[0]) for i in items); K = max(len(i[1]) for i in items)
    ids = np.zeros((n, L), np.int64); att = np.zeros((n, L), np.int64); mp = np.zeros((n, K), np.int64); mm = np.zeros((n, K), bool); qt = np.array([i[2] for i in items], np.int64)
    for a, (i, p, q) in enumerate(items):
        ids[a, :len(i)] = i; att[a, :len(i)] = 1; mp[a, :len(p)] = p; mm[a, :len(p)] = True
    return ids, att, mp, mm, qt
def both(items):
    a = mk(items); o = sess.run(None, dict(zip(['input_ids', 'attention_mask', 'marker_pos', 'marker_mask', 'qtype'], a)))
    e = model(*[torch.from_numpy(x) for x in a])
    return o[0], e[0].numpy(), o[1], e[1].numpy(), a[3]
worst = 0; flips = 0; keys = list(reqs)
for k in keys:
    ol, el, oa, ea, mm = both([reqs[k]])
    d = np.abs(ol[mm] - el[mm]).max(); worst = max(worst, d)
    if ol[0][mm[0]].argmax() != el[0][mm[0]].argmax(): flips += 1
print('single-request max |logit diff| ONNX vs eager fp32:', float(worst), 'argmax flips:', flips, flush=True)
# padded batches of mixed lengths
bw = 0
for s in range(0, 60, 6):
    items = [reqs[k] for k in keys[s:s + 6]]
    ol, el, *_rest, mm = both(items); bw = max(bw, np.abs(ol[mm] - el[mm]).max())
print('padded batch(6) max |logit diff|:', float(bw))
# also: laya's own build_sequence path for a choice row (head budget semantics)
class T:  # adapter exposing the HF-style API laya.common expects from tokenizers
    mask_token='<mask>'; mask_token_id=mask; cls_token_id=cls; sep_token_id=sep
    def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
        ids = tk.encode(text, add_special_tokens=False).ids
        return {'input_ids': ids[:max_length] if truncation and max_length else ids}
row = fx['cases'][0]; l = 'en'
q = {'t': 'choice', 'ins': row['question'][l], 'crit': {o['id']: o['description'][l] for o in row['options']}}
ids2, mk2 = lc.build_sequence(T(), row['state'][l], q, max_len=cfg['max_len'], head_max_len=cfg['head_max_len'])
print('laya build_sequence == runner layout (choice row 0, en):', ids2 == reqs[f"{row['id']}:en"][0] and mk2 == reqs[f"{row['id']}:en"][1])
