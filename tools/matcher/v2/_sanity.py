import sys, json, time, numpy as np
sys.path.insert(0, '..'); sys.path.insert(0, '../stage1')
import dem as DEM, skyglobal as SG
for pid in sys.argv[1:]:
    z = np.load(f'.cache/edges/{pid}.npz'); m = json.loads(str(z['meta']))
    d = DEM.Dem(m['frame']['lat'], m['frame']['lon'], extent_m=1000)
    t = time.time(); g0 = float(d.ground(0, 0)); t1 = time.time()
    eye = m['eye']
    hz = d.horizon(eye, 0, 359.5, 0.5); t2 = time.time()
    pa = SG.horizon_profile(z['dirs'].astype(float), 0.5); pb = SG.horizon_profile(hz['dirs'], 0.5)
    print(pid, 'frame', m['frame'], 'eye', eye, 'ground', round(g0,1), f'load {t1-t:.1f}s hz {t2-t1:.2f}s', 'prof |diff| med/p90', np.round(np.percentile(np.abs(pa-pb),[50,90]),3))
