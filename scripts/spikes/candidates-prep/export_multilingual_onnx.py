# Offline preparation for the Linux x64 candidate comparison (2026-10-21). Not part of any build or CI path.
# Needs a throwaway virtualenv, never the repository lockfiles:
#   python3 -m venv VENV && VENV/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
#   VENV/bin/pip install onnx onnxruntime numpy safetensors tokenizers transformers onnxscript laya==0.4.12   # laya only for its DecisionModel class
# Versions used: torch 2.14.1+cpu, transformers 5.20.2, onnx 1.23.2, onnxruntime 1.31.0 (quantizer only), laya 0.4.12.
# Model files are written outside the repository and are never committed.
"""Export convaiinnovations/laya-multilingual (mmBERT-base + decision head) to ONNX fp32 with the same I/O contract as
inferenceprince/laya-onnx: inputs input_ids,attention_mask,marker_pos,marker_mask,qtype; outputs logits, act_logits.
Memory-lean: the graph is traced with a 16-row stub embedding; the real 256000x768 table is streamed (bf16->fp32) into the
external data file afterwards. Usage: export_multi.py SRC_DIR DST_DIR [dynamo|legacy]"""
import sys, os, json, shutil, struct
import numpy as np, torch, onnx
from onnx import TensorProto
from safetensors import safe_open
import laya.common as lc
src, dst, mode = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else 'dynamo')
torch.set_grad_enabled(False)
cfg = json.load(open(os.path.join(src, 'rl_agent_config.json')))
from transformers import AutoConfig, AutoModel
ecfg = AutoConfig.from_pretrained(os.path.join(src, 'encoder'))
lc._apply_rope_config(ecfg)
real_vocab = ecfg.vocab_size
ecfg.vocab_size = 16
enc = AutoModel.from_config(ecfg, attn_implementation='sdpa')
model = lc.DecisionModel(enc, cfg.get('head_layers', 2), len(cfg.get('act_costs', {})) + 1)
model.eval()
EMB = 'encoder.embeddings.tok_embeddings.weight'
sd = model.state_dict()
missing = set(sd)
with safe_open(os.path.join(src, 'model.safetensors'), 'pt') as f:
    keys = list(f.keys())
    for k in keys:
        if k == EMB:
            emb_shape = f.get_slice(k).get_shape(); continue
        if k not in sd: raise SystemExit('unexpected key ' + k)
        t = f.get_tensor(k)
        if tuple(t.shape) != tuple(sd[k].shape): raise SystemExit(f'shape {k} {t.shape} {sd[k].shape}')
        sd[k].copy_(t.to(sd[k].dtype)); missing.discard(k)
missing.discard(EMB)
print('missing after load (must be empty, buffers excluded):', sorted(missing)[:10], 'emb', emb_shape, 'real_vocab', real_vocab, flush=True)
assert tuple(emb_shape) == (real_vocab, ecfg.hidden_size)
model = model.float()
print('params (stub):', sum(p.numel() for p in model.parameters()))
B, S, M = 2, 37, 3
ids = torch.randint(5, 16, (B, S)); ids[:, 0] = 2
att = torch.ones(B, S, dtype=torch.long); att[1, 30:] = 0
mpos = torch.tensor([[3, 9, 15], [4, 10, 0]]); mmask = torch.tensor([[True, True, True], [True, True, False]])
qt = torch.tensor([0, 2])
args = (ids, att, mpos, mmask, qt)
names_in = ['input_ids', 'attention_mask', 'marker_pos', 'marker_mask', 'qtype']
os.makedirs(dst, exist_ok=True)
tmp = os.path.join(dst, 'stub.onnx')
if mode == 'dynamo':
    from torch.export import Dim
    b, s, m = Dim('batch', min=1, max=64), Dim('seq', min=8, max=4096), Dim('markers', min=2, max=255)
    prog = torch.onnx.export(model, args, dynamo=True, input_names=names_in, output_names=['logits', 'act_logits'],
        dynamic_shapes={'input_ids': {0: b, 1: s}, 'attention_mask': {0: b, 1: s}, 'marker_pos': {0: b, 1: m}, 'marker_mask': {0: b, 1: m}, 'qtype': {0: b}}, opset_version=18)
    prog.save(tmp, external_data=True)
else:
    torch.onnx.export(model, args, tmp, input_names=names_in, output_names=['logits', 'act_logits'], opset_version=18, dynamo=False,
        dynamic_axes={'input_ids': {0: 'batch', 1: 'seq'}, 'attention_mask': {0: 'batch', 1: 'seq'}, 'marker_pos': {0: 'batch', 1: 'markers'},
                      'marker_mask': {0: 'batch', 1: 'markers'}, 'qtype': {0: 'batch'}, 'logits': {0: 'batch', 1: 'markers'}, 'act_logits': {0: 'batch'}})
print('exported stub graph', os.path.getsize(tmp), flush=True)
# Re-save as one external data file, then splice in the real embedding table.
m = onnx.load(tmp, load_external_data=True)
for f in os.listdir(dst):
    os.remove(os.path.join(dst, f))
data_name = 'model.onnx.data'
final = os.path.join(dst, 'model.onnx')
emb = next((t for t in m.graph.initializer if t.name == EMB), None)
print('embedding initializer present in graph:', emb is not None, [t.name for t in m.graph.initializer if 'tok_emb' in t.name], flush=True)
if emb is None: raise SystemExit('embedding initializer not found; names differ')
emb_dims = list(emb.dims)
m.graph.initializer.remove(emb)
onnx.save_model(m, final, save_as_external_data=True, all_tensors_to_one_file=True, location=data_name, size_threshold=1024)
m2 = onnx.load(final, load_external_data=False)
del m2.graph.value_info[:]  # shape annotations recorded with the 16-row stub embedding are stale for the real table
dpath = os.path.join(dst, data_name)
size = os.path.getsize(dpath); off = (size + 4095) // 4096 * 4096
ET = TensorProto()
ET.name = EMB; ET.data_type = TensorProto.FLOAT; ET.dims.extend([real_vocab, ecfg.hidden_size])
ET.data_location = TensorProto.EXTERNAL
for k, v in (('location', data_name), ('offset', str(off)), ('length', str(real_vocab * ecfg.hidden_size * 4))):
    e = ET.external_data.add(); e.key = k; e.value = v
m2.graph.initializer.append(ET)
with open(dpath, 'r+b') as out, safe_open(os.path.join(src, 'model.safetensors'), 'pt') as f:
    out.truncate(off); out.seek(off)
    sl = f.get_slice(EMB); step = 4096
    for r in range(0, real_vocab, step):
        chunk = sl[r:min(r + step, real_vocab)].to(torch.float32).contiguous().numpy()
        out.write(chunk.tobytes())
onnx.save_model(m2, final)  # small proto only, external refs kept
if os.path.exists(tmp): os.remove(tmp)  # the directory sweep above already removed it with current torch
for fn in os.listdir(dst):
    if fn != 'model.onnx' and fn != data_name and fn.startswith('stub'): os.remove(os.path.join(dst, fn))
for fn in ('config.json', 'rl_agent_config.json'): shutil.copy(os.path.join(src, fn), dst)
shutil.copytree(os.path.join(src, 'tokenizer'), os.path.join(dst, 'tokenizer'), dirs_exist_ok=True)
shutil.copytree(os.path.join(src, 'encoder'), os.path.join(dst, 'encoder'), dirs_exist_ok=True)
print(sorted((fn, os.path.getsize(os.path.join(dst, fn))) for fn in os.listdir(dst) if os.path.isfile(os.path.join(dst, fn))))
