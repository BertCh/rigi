"""Reproduce wild_dev_case.json (wc_0054 anchor -> wc_0086 target, both wild DEV split). Prints; writes nothing.
Run: tools/matcher/.venv/bin/python tools/nearfield/propagate/wild_case.py  (from the repo root)
Anchor pose = wild_dev_case.json anchorPose (tools/research/tm/cache/wc_0054/meta.json); target vfov from FF35 EXIF."""
import sys,json,math
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import run_propagate as rp
import numpy as np
from common import pose_to_R, R_to_pose
man={m['id']:m for m in json.load(open(rp.ROOT/'tools/bench/data/manifest.json'))}
case=json.load(open(rp.ROOT/'tools/nearfield/propagate/wild_dev_case.json'))
pa=case['anchorPose']
a=rp.load(rp.ROOT/'tools/bench/data'/man['wc_0054']['file']); b=rp.load(rp.ROOT/'tools/bench/data'/man['wc_0086']['file'])
KA=rp.K_of(pa['vfov'],a.width,a.height); vfB=case['suggestion']['vfov']; KB=rp.K_of(vfB,b.width,b.height)
ka,kb,_=rp.lg_match(a,b); r=rp.rot_ransac(ka,kb,KA,KB)
kb2,ka2,_=rp.lg_match(b,a); rb=rp.rot_ransac(kb2,ka2,KB,KA)
p=R_to_pose(r['R']@pose_to_R(pa),vfB)
print(r['inliers'],r['rmsPx'],rp.rot_angle(rb['R']@r['R']),p, rp.rot_angle(r['R']@np.asarray(case['relR']).T))
print('overlap', rp.overlap_frac(r['R'],KA,a.width,a.height,KB,b.width,b.height))
