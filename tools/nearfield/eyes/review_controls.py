"""Reviewer controls (2026-09-29): both eyes collapsed (baseline 0) at DIFFERENT absolute positions -> does the
reprojection / anchor evaluation measure the relative correction or the absolute eye? Writes review-controls.json.
    tools/matcher/.venv/bin/python tools/nearfield/eyes/review_controls.py
"""
import sys, json, math
from pathlib import Path
import numpy as np
R=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(R/'tools/nearfield/eyes'))
import refine_eyes as RE
from splatrender import render
spot=R/'tools/nearfield/roll/out/region-0-vp4'
meta=json.loads((spot/'meta.json').read_text())
A,B='IMG_7059','IMG_7063'
V={i:RE.View(spot,i) for i in (A,B)}
dem=RE.LocalDem(RE.EnuFrame(meta['frame']['lat'],meta['frame']['lon'],0),meta['origin'][:2])
def onz(e):
    e=np.array(e,float); e[2]=float(dem.height(e[0],e[1]))+RE.EYE_H; return e
m=(V[A].eye0+V[B].eye0)/2
w=np.array([1/37**2,1/7**2]); wm=(w[0]*V[A].eye0+w[1]*V[B].eye0)/w.sum()
confs={'both@7063gps':{A:onz(V[B].eye0),B:onz(V[B].eye0)},
 'both@7059gps':{A:onz(V[A].eye0),B:onz(V[A].eye0)},
 'both@hAccWeightedMean':{A:onz(wm),B:onz(wm)}}
for ang in (0,90,180,270):
    d=7*np.array([math.cos(math.radians(ang)),math.sin(math.radians(ang)),0])
    confs[f'collapsed+7m@{ang}']={A:onz(m+d),B:onz(m+d)}
out={}
for name,E in confs.items():
    row={}
    anc={}
    for k in (A,B):
        v=V[k]; W=256 if v.aspect>=1 else round(256*v.aspect); H=round(256/v.aspect) if v.aspect>=1 else 256
        an=RE.fit_anchor(v,RE.dem_range(dem,v,E[k],W,H)); anc[k]=an; row['q_'+k[-4:]]=round(an['quality'],3) if an else 0
    for h,o in ((A,B),(B,A)):
        T,O=V[h],V[o]
        rg=RE.dem_range(dem,T,E[h],T.W,T.H); mask=np.isfinite(rg)&(rg<=150)&~T.people
        cl=RE.lift(O,E[o],RE.anchored_ray(O,anc[o],O.W,O.H),150)
        rgb,al,_=render(cl,RE.cam_of(T,E[h])); cov=al>0.5; mc=mask&cov
        triv=np.broadcast_to(T.photo[mc].mean(0) if mc.any() else np.zeros(3),T.photo.shape)
        row[h[-4:]+'<-'+o[-4:]]=dict(mask=round(float(mask.mean()),3),cov=round(float(cov[mask].mean()),4) if mask.any() else None,psnr=RE.psnr(rgb,T.photo,mc),triv=RE.psnr(triv,T.photo,mc))
    print(name,json.dumps(row),flush=True); out[name]=row
(R/"tools/nearfield/eyes/review-controls.json").write_text(json.dumps(out,indent=1))
