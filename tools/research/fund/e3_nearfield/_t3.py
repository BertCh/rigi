import sys; sys.argv=['x']
from e3_run import *
pid='wc_0009'
m=C.load_meta(pid); v=C.load_view(pid,'refs',m['perturbBase']); K,W,H,pose=v['intrinsics'],v['W'],v['H'],v['pose']; T=np.array(v['eye'])
fr=G.EnuFrame(m['lat'],m['lon'],0); wedge=(pose['yaw'],K['hfov']/2+25)
g=D.build_grids(fr,0,0,T[2],wedge,cache=D.DATA/pid/'grid.npz'); o=D.Ortho(fr,0,0,T[2],wedge,D.DATA/pid/'tiles')
Gd,az=disp_eye(pid,50,T,g); print(Gd,az, NR.dtm_height(g,0,0))
ff=NR.upsample_xyz(v['xyz'],2,W,H)
far=NR.warp_view(v['rgb'],ff,Gd,pose,K,W,H)
r=NR.render_near(g,o,Gd,pose,K,W,H,surface='dsm'); cp=NR.composite(r,far['rgb'],far['xyz'])
rT=NR.render_near(g,o,T,pose,K,W,H,surface='dsm'); cpT=NR.composite(rT,v['rgb'],ff)
photo=np.array(Image.open(C.CACHE/pid/'photo.jpg').convert('RGB').resize((W,H)))
Image.fromarray(np.concatenate([np.concatenate([photo,v['rgb']],1),np.concatenate([cpT['rgb'],cp['rgb']],1)],0)).resize((W,H)).save('_t3.jpg')
