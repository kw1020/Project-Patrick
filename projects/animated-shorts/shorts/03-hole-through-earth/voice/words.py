import json, re, numpy as np, soundfile as sf, sys
y,sr=sf.read(sys.argv[1]); lines=json.load(open(sys.argv[2]))
hop=int(sr*0.01); env=np.array([np.sqrt(np.mean(y[i:i+hop]**2)) for i in range(0,len(y)-hop,hop)])
env=np.convolve(env,np.ones(3)/3,'same')
def syl(w):
    w=re.sub(r'[^a-z]','',w.lower())
    if not w: return 1
    if w.isdigit(): return 2
    n=len(re.findall(r'[aeiouy]+',w)); n-= w.endswith('e') and n>1
    return max(n,1)
out=[]
for L in lines:
    ws=L['text'].split(); a,b=L['start'],L['end']
    wt=[syl(w)+ (0.6 if re.search(r'[,.:;?!]$',w) else 0) for w in ws]
    cum=np.cumsum([0]+wt)/sum(wt); bounds=[a+(b-a)*c for c in cum]
    for k in range(1,len(bounds)-1):  # snap to energy dip within ±90ms
        i0=int((bounds[k]-.09)*100); i1=int((bounds[k]+.09)*100)
        seg=env[i0:i1]
        if len(seg): bounds[k]=(i0+int(np.argmin(seg)))/100
    for k,w in enumerate(ws):
        out.append({"w":re.sub(r'[^\w\'-]','',w),"start":round(bounds[k],2),"end":round(bounds[k+1],2),"line":L['i']})
json.dump(out,open(sys.argv[3],'w'),indent=0)
print(len(out),"words; last ends",out[-1]['end'])
