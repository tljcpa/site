import pickle
out=pickle.load(open("/root/复盘/work/blocks.pkl","rb"))
import sys
kw=sys.argv[1]
for b in out:
    real,role,side,bt,payload=b
    if bt in ("text","tool_result"):
        txt=payload
    elif bt=="tool_use":
        txt=str(payload[1])
    else:
        txt=str(payload)
    if kw in txt:
        snippet=txt[:600]
        print(f"[{real}] {bt} {role}: {snippet}\n----")
