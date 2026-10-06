# Fetch used on 2026-10-05 ~21:10 UTC to create data/raw/offhours/study_raw.json. Kept for provenance only: do not re-run to rebuild the study, the hosted APIs can return different values later.
import json,subprocess,time,datetime as d,statistics as st
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/127 Safari/537.36"
pools=json.load(open('pools.json'))
def sh(args): return subprocess.run(args,capture_output=True,text=True).stdout
def hl(coin,s,e):
    out={}
    while s<e:
        r=json.loads(sh(['curl','-s','-m','30','-X','POST','https://api.hyperliquid.xyz/info','-H','content-type: application/json','-d',json.dumps({"type":"candleSnapshot","req":{"coin":coin,"interval":"1h","startTime":s*1000,"endTime":e*1000}})]) or '[]')
        if not r: break
        for c in r: out[int(c['t'])//1000]=float(c['c'])
        ns=max(out)+3600
        if ns<=s: break
        s=ns; time.sleep(0.5)
    return out
def gt(pool,start,end):
    out={}; before=end
    for _ in range(4):
        j=json.loads(sh(['curl','-s','-m','30',f'https://api.geckoterminal.com/api/v2/networks/bsc/pools/{pool}/ohlcv/hour?before_timestamp={before}&limit=1000&currency=usd']) or '{}')
        l=((j.get('data') or {}).get('attributes') or {}).get('ohlcv_list') or []
        if not l: break
        for x in l: out[x[0]]=x[4]
        before=min(x[0] for x in l)
        if before<=start: break
        time.sleep(2.5)
    return out
def nas(t):
    j=json.loads(sh(['curl','-s','-m','30','-A',UA,f'https://api.nasdaq.com/api/quote/{t}/historical?assetclass=stocks&fromdate=2026-08-01&todate=2026-10-05&limit=80']) or '{}')
    rows=((j.get('data') or {}).get('tradesTable') or {}).get('rows') or []
    out={}
    for r in rows:
        m,dd,y=r['date'].split('/'); out[f"{y}-{m}-{dd}"]=(float(r['open'].strip('$').replace(',','')),float(r['close'].strip('$').replace(',','')))
    return out
S=int(d.datetime(2026,8,1,tzinfo=d.UTC).timestamp()); E=int(d.datetime(2026,10,5,14,tzinfo=d.UTC).timestamp())
data={}
for t,(pool,liq,created) in pools.items():
    coin='xyz:SKHX' if t=='SKHY' else 'xyz:'+t
    data[t]={'hl':hl(coin,S,E),'gt':gt(pool,S,E),'nas':nas(t),'liq':liq}
    print(t,len(data[t]['hl']),len(data[t]['gt']),len(data[t]['nas']),flush=True)
    time.sleep(1)
json.dump({t:{'hl':{str(k):v for k,v in x['hl'].items()},'gt':{str(k):v for k,v in x['gt'].items()},'nas':x['nas'],'liq':x['liq']} for t,x in data.items()},open('study_raw.json','w'))
