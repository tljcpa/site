import json, sys, re
pat=re.compile(sys.argv[2], re.I)
def blocks(content):
    if isinstance(content,str): return [("text",content)]
    out=[]
    if isinstance(content,list):
        for b in content:
            if not isinstance(b,dict): continue
            t=b.get("type")
            if t=="text": out.append(("text",b.get("text","")))
            elif t=="tool_use":
                inp=b.get("input",{})
                out.append(("tool_use", (inp.get("command") or json.dumps(inp,ensure_ascii=False))))
            elif t=="tool_result":
                c=b.get("content","")
                if isinstance(c,list): c=" ".join(x.get("text","") for x in c if isinstance(x,dict))
                out.append(("tool_result",str(c)))
    return out
path=sys.argv[1]
with open(path) as f:
    for i,line in enumerate(f,1):
        line=line.strip()
        if not line: continue
        try: obj=json.loads(line)
        except: continue
        msg=obj.get("message",obj)
        for t,c in blocks(msg.get("content","")):
            if pat.search(c):
                print(f"=== [{i}] {t} ===")
                print(c[:1500])
                print()
