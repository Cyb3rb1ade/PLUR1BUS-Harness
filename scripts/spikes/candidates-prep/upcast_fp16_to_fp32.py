# Offline preparation for the Linux x64 candidate comparison (2026-10-21). Not part of any build or CI path.
# Needs a throwaway virtualenv, never the repository lockfiles:
#   python3 -m venv VENV && VENV/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
#   VENV/bin/pip install onnx onnxruntime numpy safetensors tokenizers transformers onnxscript laya==0.4.12   # laya only for its DecisionModel class
# Versions used: torch 2.14.1+cpu, transformers 5.20.2, onnx 1.23.2, onnxruntime 1.31.0 (quantizer only), laya 0.4.12.
# Model files are written outside the repository and are never committed.
import sys, os, shutil, numpy as np, onnx
from onnx import numpy_helper, TensorProto
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(os.path.join(src, 'model.onnx'), load_external_data=True); g = m.graph
for t in g.initializer:
    if t.data_type == TensorProto.FLOAT16:
        t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float32), t.name))
for n in g.node:
    if n.op_type == 'Cast':
        for a in n.attribute:
            if a.name == 'to' and a.i == TensorProto.FLOAT16: a.i = TensorProto.FLOAT
del g.value_info[:]
os.makedirs(dst, exist_ok=True)
onnx.save_model(m, os.path.join(dst, 'model.onnx'), save_as_external_data=True, all_tensors_to_one_file=True, location='model.onnx.data', size_threshold=1024)
for f in ('config.json', 'rl_agent_config.json'): shutil.copy(os.path.join(src, f), dst)
shutil.copytree(os.path.join(src, 'tokenizer'), os.path.join(dst, 'tokenizer'), dirs_exist_ok=True)
