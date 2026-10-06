# Builds study_rows.json (all 15 stocks, 8 weekends) from study_raw.json and prints the unfiltered summary.
# Run inside data/raw/offhours: python3 ../../../scripts/study/reference/build_rows.py
import json,datetime as d,statistics as st
raw=json.load(open('study_raw.json'))
def near(series,t,maxback=6*3600):
    ks=[int(k) for k in series if t-maxback<=int(k)<=t]
    return series[str(max(ks))] if ks else None
rows=[]
for T,x in raw.items():
    days=sorted(x['nas'])
    for i,day in enumerate(days[:-1]):
        dt=d.date.fromisoformat(day)
        if dt.weekday()!=4: continue
        nxt=days[i+1]; C=x['nas'][day][1]; O=x['nas'][nxt][0]
        fri=d.datetime(dt.year,dt.month,dt.day,20,tzinfo=d.UTC)
        nd=d.date.fromisoformat(nxt)
        cps={'Sat12':fri+d.timedelta(hours=16),'Sun23':fri+d.timedelta(days=2,hours=3),'Mon07':d.datetime(nd.year,nd.month,nd.day,7,tzinfo=d.UTC)}
        r={'T':T,'fri':day,'C':C,'O':O,'gap':O/C-1}
        for n,t in cps.items():
            ts=int(t.timestamp())
            r['H_'+n]=near(x['hl'],ts); r['B_'+n]=near(x['gt'],ts,maxback=24*3600)
        rows.append(r)
json.dump(rows,open('study_rows.json','w'))
print('weekend-stock samples:',len(rows))
def med(a): return st.median(a) if a else float('nan')
for n in ['Sat12','Sun23','Mon07']:
    ok=[r for r in rows if r['H_'+n] and r['B_'+n]]
    eC=[abs(r['O']/r['C']-1)*100 for r in ok]; eH=[abs(r['O']/r['H_'+n]-1)*100 for r in ok]; eB=[abs(r['O']/r['B_'+n]-1)*100 for r in ok]
    dev=[abs(r['B_'+n]/r['H_'+n]-1)*100 for r in ok]
    hb=sum(1 for a,b in zip(eH,eC) if a<b); bb=sum(1 for a,b in zip(eB,eC) if a<b)
    print(f"\n{n}: n={len(ok)}  median |error to Monday open|: Friday close {med(eC):.2f}%  HL perp {med(eH):.2f}%  BSC token {med(eB):.2f}%")
    print(f"   HL closer than Friday close in {hb}/{len(ok)}; BSC token closer in {bb}/{len(ok)}")
    print(f"   |BSC - HL| median {med(dev):.2f}%  >0.5%: {sum(v>0.5 for v in dev)}  >1%: {sum(v>1 for v in dev)}  >2%: {sum(v>2 for v in dev)}")
    # edge: trade BSC toward HL, exit at Monday open
    for thr in [0.5,1.0,2.0]:
        sig=[(1 if r['H_'+n]>r['B_'+n] else -1)*(r['O']/r['B_'+n]-1)*100 for r in ok if abs(r['B_'+n]/r['H_'+n]-1)*100>thr]
        if sig: print(f"   trade toward HL when gap>{thr}%: n={len(sig)} mean {st.mean(sig):+.2f}% median {med(sig):+.2f}% win {sum(s>0 for s in sig)}/{len(sig)}")
