import argparse,json
from pathlib import Path
parser=argparse.ArgumentParser(description='Extract allowlisted custom audit from private Wrangler tail capture.')
parser.add_argument('--directory',type=Path,required=True); p=parser.parse_args().directory; text=(p/'tail.raw.jsonl').read_text(); decoder=json.JSONDecoder(); pos=0; records=[]; statuses=[]
allowed=set('schemaVersion time requestId spanId component sequence level event build source snapshot package version sha256 stage reason originHost githubRequestId clientRequestId cache lease period state status durationMs bytes expectedBytes attempt usedBytes reservedBytes classA classB limit rows rateLimitRemaining rateLimitReset retryAfterSeconds metadataAgeSeconds'.split())
while pos<len(text):
    start=text.find('{',pos)
    if start<0: break
    try: obj,used=decoder.raw_decode(text[start:]); pos=start+used
    except json.JSONDecodeError: pos=start+1; continue
    if not isinstance(obj,dict): continue
    if 'outcome' in obj: statuses.append(obj['outcome'])
    for log in obj.get('logs',[]):
        for message in log.get('message',[]):
            if not isinstance(message,str): continue
            try: record=json.loads(message)
            except json.JSONDecodeError: continue
            if isinstance(record,dict) and record.get('schemaVersion')==1 and record.get('component') in ['worker','cache'] and set(record)<=allowed: records.append(record)
(p/'audit.filtered.jsonl').write_text(''.join(json.dumps(r,separators=(',',':'))+'\n' for r in records))
results=json.loads((p/'live-results.json').read_text()); proof={}
for result in results:
    matching=[r for r in records if r['requestId']==result['requestId']]; proof[result['name']]={'events':len(matching),'highlights':[r for r in matching if r['event'].startswith('cache.') or r['event'].startswith('stream.') or r['event']=='request.complete']}
(p/'audit-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
for result in results:
    matching=[r for r in records if r['requestId']==result['requestId']]
    assert matching,result['name']+' has no captured audit'
    terminal=[r for r in matching if r['component']=='worker' and r['event']=='request.complete']
    assert len(terminal)==1 and terminal[0]['status']==result['status'],result['name']+' missing terminal'
    assert all(r.get('clientRequestId')==result['clientRequestId'] for r in matching)
for name in ['package-cold','package-existing-cache','package-warm','package-after-redeploy','package-origin-first','package-origin-repeat']:
    if name not in proof: continue
    highlights=proof[name]['highlights']; events=[r['event'] for r in highlights]
    assert 'stream.verified' in events,name+' has no validated stream'
    if name=='package-cold':
        assert 'cache.fill_reserved' in events and 'cache.fill_committed' in events and any(r['event']=='cache.fill_result' and r.get('status')==201 for r in highlights)
    elif name.startswith('package-origin-'):
        assert 'cache.r2_hit' not in events and 'cache.fill_reserved' not in events
        assert any(r['event']=='cache.r2_bypass' and r.get('reason')=='NotConfigured' for r in highlights),name+' unexpectedly used cache resources'
    else:
        assert 'cache.r2_hit' in events and 'cache.hit' in events and 'cache.fill_reserved' not in events,name+' did not hit cache'
    print(name,':',', '.join(events))
print('Correlated audit assertions passed; filtered records:',len(records))
