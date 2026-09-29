import json, sys, glob, numpy as np
def dang(a,b): return (a-b+540)%360-180
def feats(r, kind):
    if kind=='raw': return r['score']
    if kind=='z': return (r['score']-r['med'])/max(r['std'],1e-6)
    if kind=='gap': return r['score']-r['second']
    if kind=='p90': return r['score']-r['p90']
    if kind=='open': return r['score']*(0.5+r['open'])
for kind in ['raw','z','gap','p90','open']:
    ranks=[];agree=[];top_at_stated=0;n=0
    for f in sorted(glob.glob('.cache/eyecal/*.json')):
        d=json.load(open(f));
        if not d['refs']: continue
        n+=1
        rows=sorted(d['rows'],key=lambda r:-feats(r,kind))
        st=[i for i,r in enumerate(rows) if r['en']==[0.0,0.0]][0]
        ranks.append(st)
        ref=d['refs'][0]['pose']
        # does the stated eye's best yaw agree with ref?
        s=rows[st]; agree.append(abs(dang(s['pose']['yaw'],ref['yaw']))<3)
        top=rows[0]; dist=np.hypot(*top['en'])
        top_at_stated+= dist<=75
    ranks=np.array(ranks)
    print(f"{kind:5} n={n} stated-eye rank median={np.median(ranks):.0f} top1={np.mean(ranks==0):.2f} top5={np.mean(ranks<5):.2f} top10={np.mean(ranks<10):.2f} | top eye within 75m: {top_at_stated}/{n} | stated best-yaw agrees ref: {sum(agree)}/{n}")
