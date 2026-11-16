import sys, json, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
M=sys.argv[1]; voice=sys.argv[2]; speed=float(sys.argv[3]); out=sys.argv[4]
k=Kokoro(f"{M}/kokoro-v1.0.onnx", f"{M}/voices-v1.0.bin")
lines=[l.strip() for l in open(sys.argv[5]) if l.strip()]
sr=24000; parts=[]; meta=[]; t=0.25
parts.append(np.zeros(int(.25*sr),dtype=np.float32))
for i,l in enumerate(lines):
    a,sr=k.create(l, voice=voice, speed=speed, lang="en-us")
    a=a.astype(np.float32)
    # trim leading/trailing silence
    idx=np.where(np.abs(a)>0.01)[0]; a=a[max(idx[0]-240,0):idx[-1]+480]
    meta.append({"i":i,"text":l,"start":round(t,3),"end":round(t+len(a)/sr,3)})
    parts.append(a); t+=len(a)/sr
    gap=0.22 if not l.endswith('?') else 0.4
    if i in (0,): gap=0.45
    if i == len(lines) - 2: gap=0.3
    parts.append(np.zeros(int(gap*sr),dtype=np.float32)); t+=gap
y=np.concatenate(parts); sf.write(out,y,sr)
json.dump(meta,open(out.replace('.wav','_lines.json'),'w'),indent=1)
print(voice, round(len(y)/sr,1),"s")
