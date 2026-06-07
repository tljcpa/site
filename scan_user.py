import json, sys

def extract_text(content):
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text",""))
    return "\n".join(parts)

path = sys.argv[1]
with open(path) as f:
    for i, line in enumerate(f, 1):
        line=line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
        except:
            continue
        msg = obj.get("message", obj)
        role = msg.get("role") or obj.get("type")
        if role == "user":
            txt = extract_text(msg.get("content", obj.get("content","")))
            if txt.strip():
                txt = txt.replace("\n"," ")[:300]
                print(f"[{i}] USER: {txt}")
