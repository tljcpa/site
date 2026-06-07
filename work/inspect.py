import json
path = "/home/claude/backups/cc-mirror/data/-root-----02/c97e2b5b-3387-47c3-95e9-55d439a21118.jsonl"
lines = open(path).readlines()[24000:]
seen=set()
for i, ln in enumerate(lines):
    ln=ln.strip()
    if not ln: continue
    obj=json.loads(ln)
    t=obj.get("type")
    if t in ("assistant","user") and t not in seen:
        seen.add(t)
        print("==== TYPE",t,"line",24001+i,"keys:",list(obj.keys()))
        print(json.dumps(obj, ensure_ascii=False)[:1500])
        print()
    if len(seen)>=2: break
