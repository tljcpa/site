import json

path = "/home/claude/backups/cc-mirror/data/-root-----02/c97e2b5b-3387-47c3-95e9-55d439a21118.jsonl"
lines = open(path).readlines()[24000:]
print("total lines to read:", len(lines), "start jsonl line:", 24001, "end:", 24000+len(lines))

count_by_type = {}
for i, ln in enumerate(lines):
    ln = ln.strip()
    if not ln:
        continue
    try:
        obj = json.loads(ln)
    except Exception as e:
        print(24001+i, "PARSE ERR", e)
        continue
    t = obj.get("type")
    count_by_type[t] = count_by_type.get(t,0)+1
print(count_by_type)
