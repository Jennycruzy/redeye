# F20 summary: drops AAPL (pool price unit broken) and SKHY (Hyperliquid SKHX is a different instrument) -> 104 rows, 13 stocks.
# Run inside data/raw/offhours after build_rows.py: python3 ../../../scripts/study/reference/analyze.py
import json,statistics as st
rows=[r for r in json.load(open('study_rows.json')) if r['T'] not in ('AAPL','SKHY')]
def med(a): return st.median(a) if a else float('nan')
print('samples',len(rows),'stocks',sorted(set(r['T'] for r in rows)))
print('median |weekend gap| (Fri close→Mon open):',round(med([abs(r['gap'])*100 for r in rows]),2),'%')
for n in ['Sat12','Sun23','Mon07']:
    ok=[r for r in rows if r['H_'+n] and r['B_'+n]]
    eC=[abs(r['O']/r['C']-1)*100 for r in ok]; eH=[abs(r['O']/r['H_'+n]-1)*100 for r in ok]; eB=[abs(r['O']/r['B_'+n]-1)*100 for r in ok]
    dev=[(r['B_'+n]/r['H_'+n]-1)*100 for r in ok]
    print(f"\n{n}: n={len(ok)} | median error to Monday open: Fri close {med(eC):.2f}% · HL perp {med(eH):.2f}% · BSC token {med(eB):.2f}%")
    print(f"   closer than Fri close: HL {sum(a<b for a,b in zip(eH,eC))}/{len(ok)} · BSC {sum(a<b for a,b in zip(eB,eC))}/{len(ok)}")
    print(f"   BSC vs HL: median |diff| {med([abs(v) for v in dev]):.2f}% · >0.5%: {sum(abs(v)>0.5 for v in dev)} · >1%: {sum(abs(v)>1 for v in dev)} · max {max(abs(v) for v in dev):.2f}%")
    for thr in [0.3,0.5,1.0]:
        sig=[(1 if r['H_'+n]>r['B_'+n] else -1)*(r['O']/r['B_'+n]-1)*100 for r in ok if abs(r['B_'+n]/r['H_'+n]-1)*100>thr]
        if sig: print(f"   trade BSC toward HL if diff>{thr}%: n={len(sig)} mean {st.mean(sig):+.2f}% median {med(sig):+.2f}% wins {sum(s>0 for s in sig)}/{len(sig)}")
    # direction: does HL weekend move predict gap sign?
    sgn=[(r['H_'+n]-r['C'])*(r['O']-r['C'])>0 for r in ok if abs(r['H_'+n]/r['C']-1)>0.005]
    print(f"   HL weekend move (>0.5%) had the right direction for Monday: {sum(sgn)}/{len(sgn)}")
