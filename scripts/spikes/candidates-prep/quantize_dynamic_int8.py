# Offline preparation for the Linux x64 candidate comparison (2026-10-21). Not part of any build or CI path.
# Needs a throwaway virtualenv, never the repository lockfiles:
#   python3 -m venv VENV && VENV/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
#   VENV/bin/pip install onnx onnxruntime numpy safetensors tokenizers transformers onnxscript laya==0.4.12   # laya only for its DecisionModel class
# Versions used: torch 2.14.1+cpu, transformers 5.20.2, onnx 1.23.2, onnxruntime 1.31.0 (quantizer only), laya 0.4.12.
# Model files are written outside the repository and are never committed.
import sys, os, shutil, collections, onnx
from onnxruntime.quantization import quantize_dynamic, QuantType
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
quantize_dynamic(os.path.join(src, 'model.onnx'), os.path.join(dst, 'model.onnx'), per_channel=True, reduce_range=False, weight_type=QuantType.QInt8, use_external_data_format=True)
for f in ('config.json', 'rl_agent_config.json'): shutil.copy(os.path.join(src, f), dst)
shutil.copytree(os.path.join(src, 'tokenizer'), os.path.join(dst, 'tokenizer'), dirs_exist_ok=True)
q = onnx.load(os.path.join(dst, 'model.onnx'), load_external_data=False)
print(collections.Counter(n.op_type for n in q.graph.node).most_common(10)); print(collections.Counter(t.data_type for t in q.graph.initializer))
for f in sorted(os.listdir(dst)):
    p = os.path.join(dst, f)
    if os.path.isfile(p): print(f, os.path.getsize(p))
