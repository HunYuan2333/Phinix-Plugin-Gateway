#!/usr/bin/env python3
"""Standard Wrangler authenticated service bridge. No credential reads or public admin API."""
import argparse,json,os,sys,urllib.request,urllib.error,urllib.parse
from pathlib import Path

def strict(raw):
    def fields(pairs):
        result={}
        for key,value in pairs:
            if key in result: raise ValueError('Duplicate JSON field')
            result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=fields)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:18787/operations');parser.add_argument('--epoch',required=True);parser.add_argument('--period',required=True)
    commands=parser.add_subparsers(dest='action',required=True)
    inspect=commands.add_parser('inspect');inspect.add_argument('--output',type=Path,required=True)
    confirm=commands.add_parser('confirm');confirm.add_argument('--inspection',type=Path,required=True);confirm.add_argument('--key',required=True);confirm.add_argument('--apply',action='store_true')
    args=parser.parse_args();url=urllib.parse.urlsplit(args.url)
    if url.scheme!='http' or url.hostname!='127.0.0.1' or url.path!='/operations' or url.query or url.fragment or url.username or url.password: raise ValueError('Bridge must be local 127.0.0.1')
    data=dict(schemaVersion=1,epoch=args.epoch,period=args.period)
    if args.action=='confirm':
        with args.inspection.open('rb') as stream:raw=stream.read(1024*1024+1)
        if len(raw)>1024*1024: raise ValueError('Inspection exceeds limit')
        snapshot=strict(raw)
        if snapshot.get('schemaVersion')!=1 or snapshot.get('ok') is not True:raise ValueError('Invalid inspection')
        result=snapshot['result'];meta=result['meta']
        if meta['epoch']!=args.epoch or meta['period']!=args.period:raise ValueError('Inspection target mismatch')
        matches=[row for row in result['objects'] if row['entry']['key']==args.key]
        if len(matches)!=1:raise ValueError('Expected one inspected object')
        selected=matches[0];entry=selected['entry']
        if selected['active'] or entry['state'] not in ('writing','uncertain'):raise ValueError('Object not recoverable')
        data.update(entry={field:entry[field] for field in ('source','package','version','sha256','sizeBytes')},lease=entry['lease'],fingerprint=selected['fingerprint'])
        print(json.dumps(dict(action='confirm',entry=data['entry'],lease=data['lease'],fingerprint=data['fingerprint'],capacityReleased=False)))
        if not args.apply:
            print('Plan only. Use --apply after reviewing the fixed object identity.');return 0
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request=urllib.request.Request(args.url,data=json.dumps(dict(action=args.action,input=data)).encode(),headers={'Content-Type':'application/json'},method='POST')
    print(json.dumps(dict(event='operations.waiting',action=args.action,httpTimeoutSeconds=45)),file=sys.stderr,flush=True)
    try: response=opener.open(request,timeout=45)
    except urllib.error.HTTPError as error:response=error
    with response:
        status=response.getcode();raw=response.read(1024*1024+1)
    if len(raw)>1024*1024:raise ValueError('Operations response exceeds limit')
    result=strict(raw)
    if result.get('schemaVersion')!=1 or result.get('ok') is not True:
        print(json.dumps(dict(code=result.get('code'),requestId=result.get('requestId'),status=status)),file=sys.stderr);return 1
    if args.action=='inspect':
        # Do not overwrite a captured incident snapshot. The caller chooses a new file for each inspection.
        fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(raw)
        print(json.dumps(dict(requestId=result['requestId'],meta=result['result']['meta'],totals=result['result']['totals'],objects=len(result['result']['objects']),output=str(args.output))))
    else:print(json.dumps(result))
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print('Operations failed: '+type(error).__name__,file=sys.stderr);sys.exit(1)
