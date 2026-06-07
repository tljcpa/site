import pickle, json, sys
out=pickle.load(open("/root/复盘/work/blocks.pkl","rb"))
start=int(sys.argv[1]); end=int(sys.argv[2])
for b in out[start:end]:
    real,role,side,bt,payload=b
    if bt=="text":
        print(f"\n===[{real}] {role.upper()} TEXT===")
        print(payload)
    elif bt=="thinking":
        print(f"\n---[{real}] {role} THINKING---")
        print(payload)
    elif bt=="tool_use":
        name,inp=payload
        s=json.dumps(inp,ensure_ascii=False)
        if len(s)>1200: s=s[:1200]+" ...[truncated input]"
        print(f"\n>>>[{real}] TOOL_USE {name}: {s}")
    elif bt=="tool_result":
        txt=payload
        if len(txt)>2500: txt=txt[:2500]+"\n...[truncated result, total len="+str(len(payload))+"]"
        print(f"\n<<<[{real}] TOOL_RESULT:\n{txt}")
