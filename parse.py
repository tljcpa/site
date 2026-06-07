import json
path='/home/claude/backups/cc-mirror/data/-root-----02/c97e2b5b-3387-47c3-95e9-55d439a21118.jsonl'
lines=open(path).readlines()[19200:24000]

for i,l in enumerate(lines):
    ln=19200+i
    try:
        o=json.loads(l)
    except:
        continue
    t=o.get('type')
    if t=='queue-operation':
        continue
    msg=o.get('message',{})
    role=msg.get('role','') if isinstance(msg,dict) else ''
    content=msg.get('content') if isinstance(msg,dict) else None
    side=o.get('isSidechain')
    prefix=f"[{ln}] {t}/{role}{' SIDE' if side else ''}"
    if isinstance(content,str):
        print(prefix, '| TEXT:', content[:5000])
    elif isinstance(content,list):
        for blk in content:
            if not isinstance(blk,dict): continue
            bt=blk.get('type')
            if bt=='text':
                print(prefix,'| text:',blk.get('text','')[:5000])
            elif bt=='thinking':
                print(prefix,'| THINK:',blk.get('thinking','')[:5000])
            elif bt=='tool_use':
                inp=blk.get('input',{})
                cmd=inp.get('command') or inp.get('description') or json.dumps(inp,ensure_ascii=False)[:2500]
                print(prefix,'| TOOL_USE',blk.get('name'),':',str(cmd)[:2500])
            elif bt=='tool_result':
                cont=blk.get('content')
                if isinstance(cont,list):
                    txt=' '.join(x.get('text','') for x in cont if isinstance(x,dict))
                else:
                    txt=str(cont)
                print(prefix,'| RESULT:',txt[:4000])
    print()
