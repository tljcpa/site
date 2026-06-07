import json, sys
def blocks(content):
    if isinstance(content,str): return [("text",content)]
    out=[]
    if isinstance(content,list):
        for b in content:
            if not isinstance(b,dict): continue
            t=b.get("type")
            if t=="text": out.append(("text",b.get("text","")))
            elif t=="tool_use":
                name=b.get("name",""); inp=b.get("input",{})
                cmd=inp.get("command") or inp.get("description") or json.dumps(inp,ensure_ascii=False)[:200]
                out.append(("tool_use",f"{name}: {cmd}"))
            elif t=="tool_result":
                c=b.get("content","")
                if isinstance(c,list):
                    c=" ".join(x.get("text","") for x in c if isinstance(x,dict))
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
        role=msg.get("role") or obj.get("type")
        if role=="assistant":
            for t,c in blocks(msg.get("content","")):
                if t=="text" and c.strip():
                    print(f"[{i}] ASST: {c.replace(chr(10),' ')[:400]}")
