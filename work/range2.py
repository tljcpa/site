import pickle, json, sys
out=pickle.load(open("/root/复盘/work/blocks.pkl","rb"))
lo=int(sys.argv[1]); hi=int(sys.argv[2])
for b in out:
    real,role,side,bt,payload=b
    if real<lo or real>hi: continue
    if bt=="text":
        print(f"\n===[{real}] {role.upper()}===\n{payload[:1500]}")
    elif bt=="tool_use":
        name,inp=payload
        print(f"\n>>>[{real}] {name}: {json.dumps(inp,ensure_ascii=False)[:500]}")
    elif bt=="tool_result":
        print(f"\n<<<[{real}] RESULT: {payload[:900]}")
