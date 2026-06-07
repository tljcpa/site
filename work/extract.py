import json
path = "/home/claude/backups/cc-mirror/data/-root-----02/c97e2b5b-3387-47c3-95e9-55d439a21118.jsonl"
lines = open(path).readlines()[24000:]

out=[]
for i, ln in enumerate(lines):
    real=24001+i
    ln=ln.strip()
    if not ln: continue
    obj=json.loads(ln)
    t=obj.get("type")
    if t not in ("assistant","user"): 
        continue
    msg=obj.get("message",{})
    role=msg.get("role")
    side=obj.get("isSidechain")
    content=msg.get("content")
    if isinstance(content,str):
        out.append((real,role,side,"text",content))
        continue
    if not isinstance(content,list): 
        continue
    for block in content:
        if not isinstance(block,dict): continue
        bt=block.get("type")
        if bt=="text":
            out.append((real,role,side,"text",block.get("text","")))
        elif bt=="thinking":
            th=block.get("thinking","")
            if th.strip():
                out.append((real,role,side,"thinking",th))
        elif bt=="tool_use":
            name=block.get("name")
            inp=block.get("input",{})
            out.append((real,role,side,"tool_use",(name,inp)))
        elif bt=="tool_result":
            c=block.get("content")
            txt=""
            if isinstance(c,str): txt=c
            elif isinstance(c,list):
                parts=[]
                for x in c:
                    if isinstance(x,dict) and x.get("type")=="text":
                        parts.append(x.get("text",""))
                txt="\n".join(parts)
            out.append((real,role,side,"tool_result",txt))

# write to a file we can read in chunks
import pickle
with open("/root/复盘/work/blocks.pkl","wb") as f:
    pickle.dump(out,f)
print("total blocks:", len(out))
# print type counts and sidechain counts
from collections import Counter
print(Counter((b[3], b[2]) for b in out))
