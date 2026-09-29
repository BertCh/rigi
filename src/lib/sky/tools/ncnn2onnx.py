"""
Converts the MIT-licensed U^2-Net-P sky model (ncnn fp16) from
https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing
(skysegsmall_sim-opt-fp16.param/.bin) to ONNX with dynamic H/W, keeping only
the fused output. Needs: pip install onnx numpy.

  python ncnn2onnx.py skysegsmall_sim-opt-fp16.param skysegsmall_sim-opt-fp16.bin skyseg-u2netp.onnx
"""
import sys
import numpy as np, onnx, struct
from onnx import helper, numpy_helper, TensorProto
lines = open(sys.argv[1]).read().split('\n')[2:]
layers = []
for ln in lines:
    t = ln.split()
    if not t: continue
    typ, name, nb, nt = t[0], t[1], int(t[2]), int(t[3])
    bots = t[4:4+nb]; tops = t[4+nb:4+nb+nt]
    params = {}
    for kv in t[4+nb+nt:]:
        k, v = kv.split('='); params[int(k)] = v
    layers.append((typ, name, bots, tops, params))
blob = open(sys.argv[2], 'rb').read(); off = 0
def load(n, typ):
    global off
    if typ == 1:
        a = np.frombuffer(blob, np.float32, n, off); off += 4*n; return a.copy()
    flag = struct.unpack_from('<I', blob, off)[0]; off += 4
    if flag == 0x01306B47:
        a = np.frombuffer(blob, np.float16, n, off).astype(np.float32); off += (2*n + 3)//4*4; return a
    if flag == 0:
        a = np.frombuffer(blob, np.float32, n, off); off += 4*n; return a.copy()
    raise Exception(hex(flag))
alias = {}
def R(b):
    while b in alias: b = alias[b]
    return b
producer = {}
for typ, name, bots, tops, p in layers:
    if typ == 'Split':
        for t in tops: alias[t] = bots[0]
    for t in tops: producer[t] = typ
consumers = {}
for typ, name, bots, tops, p in layers:
    for b in bots: consumers.setdefault(R(b), []).append((typ, [R(x) for x in bots]))
nodes, inits = [], []
def const(name, arr):
    inits.append(numpy_helper.from_array(arr, name)); return name
for typ, name, bots, tops, p in layers:
    bots = [R(b) for b in bots]
    if typ in ('Input', 'Split'): continue
    out = tops[0]
    if typ == 'Convolution':
        co = int(p[0]); k = int(p[1]); dil = int(p.get(2, 1)); st = int(p.get(3, 1)); pad = int(p.get(4, 0)); n = int(p[6])
        ci = n // (co*k*k)
        w = load(n, 0).reshape(co, ci, k, k); b = load(co, 1) if p.get(5) == '1' else np.zeros(co, np.float32)
        act = p.get(9, '0'); conv_out = out if act == '0' else out + '_pre'
        nodes.append(helper.make_node('Conv', [bots[0], const(name+'_w', w), const(name+'_b', b)], [conv_out], kernel_shape=[k,k], dilations=[dil,dil], strides=[st,st], pads=[pad]*4))
        if act == '1': nodes.append(helper.make_node('Relu', [conv_out], [out]))
        elif act == '4': nodes.append(helper.make_node('Sigmoid', [conv_out], [out]))
        elif act != '0': raise Exception(act)
    elif typ == 'Pooling':
        assert p.get(0, '0') == '0' and p.get(5, '0') == '0'
        nodes.append(helper.make_node('MaxPool', bots, [out], kernel_shape=[2,2], strides=[2,2], ceil_mode=0))  # multiples of 32: ceil is a no-op; WebGPU lacks ceil_mode
    elif typ == 'Interp':
        assert p[0] == '2'
        cat = [c for c in consumers[out] if c[0] == 'Concat'][0][1]
        partner = [b for b in cat if b != out and producer.get(b) != 'Interp'][0]
        nodes += [helper.make_node('Shape', [bots[0]], [name+'_s0'], end=2), helper.make_node('Shape', [partner], [name+'_s1'], start=2),
                  helper.make_node('Concat', [name+'_s0', name+'_s1'], [name+'_sz'], axis=0),
                  helper.make_node('Resize', [bots[0], '', '', name+'_sz'], [out], mode='linear', coordinate_transformation_mode='half_pixel')]
    elif typ == 'Concat':
        nodes.append(helper.make_node('Concat', bots, [out], axis=1))
    elif typ == 'BinaryOp':
        assert p.get(0, '0') == '0'; nodes.append(helper.make_node('Add', bots, [out]))
    elif typ == 'Sigmoid':
        pass  # side outputs unused
    else: raise Exception(typ)
print('consumed', off, 'of', len(blob))
g = helper.make_graph(nodes, 'u2netp_sky', [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1,3,'H','W'])],
                      [helper.make_tensor_value_info('1959', TensorProto.FLOAT, [1,1,'H','W'])], inits)
g.node[0].input[0] = 'input'
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 18)]); m.ir_version = 8
onnx.checker.check_model(m); onnx.save(m, sys.argv[3])
import os; print(os.path.getsize(sys.argv[3]))
