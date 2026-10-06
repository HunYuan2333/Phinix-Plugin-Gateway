import argparse,json,hashlib,uuid,urllib.request,urllib.error,time
from pathlib import Path
parser=argparse.ArgumentParser(description='Explicit controlled PoC check; never called by npm test.')
parser.add_argument('--endpoint',required=True); parser.add_argument('--directory',type=Path,required=True); parser.add_argument('--after-redeploy',action='store_true')
parser.add_argument('--direct',action='store_true',help='Ignore environment/system HTTP proxies for endpoint requests.')
parser.add_argument('--existing-cache',action='store_true',help='Label the first package read as existing-cache acceptance, not a cold fill.')
parser.add_argument('--public',action='store_true',help='Verify anonymous staging access; never read or send the PoC secret.')
parser.add_argument('--origin-only',action='store_true',help='Label package requests as origin reads, without cache-hit claims.')
parser.add_argument('--require-package-length',action='store_true',help='Require the real package response to retain its locked Content-Length.')
args=parser.parse_args()
if args.origin_only and (not args.public or args.existing_cache or args.after_redeploy): parser.error('--origin-only requires --public and excludes cache/redeploy modes')
p=args.directory; token=None if args.public else json.loads((p/'secrets.json').read_text())['POC_ACCESS_TOKEN']; base=args.endpoint.rstrip('/'); assert base.startswith('https://')
results=json.loads((p/'live-results.json').read_text()) if args.after_redeploy else []
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):return None
opener=urllib.request.build_opener(NoRedirect(),*([urllib.request.ProxyHandler({})] if args.direct else []))
def check(name,path,status=200,expected=None,auth=True,extra=None):
    headers={'User-Agent':'Phinix-PluginStore-LiveProbe/1','X-Phinix-Client-Request-Id':uuid.uuid4().hex,'Accept-Encoding':'identity'}
    if auth and token is not None: headers['Authorization']='Bearer '+token
    headers.update(extra or {})
    req=urllib.request.Request(base+path,headers=headers)
    started=time.monotonic()
    try: response=opener.open(req,timeout=45)
    except urllib.error.HTTPError as e: response=e
    except urllib.error.URLError as e:
        reason=getattr(e,'reason',e)
        print(json.dumps({'name':name,'errorCode':'ProbeNetworkError','errorType':type(reason).__name__,'errno':getattr(reason,'errno',None),'direct':args.direct}),flush=True)
        raise SystemExit(1)
    with response: raw=response.read(2*1024*1024+1); code=response.code; h=response.headers
    assert len(raw)<=2*1024*1024,name+' response exceeds probe limit'
    result={'name':name,'status':code,'bytes':len(raw),'contentLength':h.get('Content-Length'),'requestId':h.get('X-Phinix-Request-Id'),'clientRequestId':headers['X-Phinix-Client-Request-Id'],'sha256':hashlib.sha256(raw).hexdigest(),'etag':h.get('ETag'),'cacheControl':h.get('Cache-Control'),'direct':args.direct,'durationMs':round((time.monotonic()-started)*1000)}
    if code>=400:
        try: result['errorCode']=json.loads(raw).get('code')
        except Exception: result['errorCode']='NonJsonError'
    results.append(result); (p/'live-results.json').write_text(json.dumps(results,indent=2)+'\n'); print(json.dumps(result),flush=True)
    assert code==status,(name,code,result.get('errorCode'))
    if expected is not None: assert raw==expected.read_bytes(),name+' bytes differ'
    if args.require_package_length and name.startswith('package-') and code==200:
        assert h.get('Content-Length')==str(len(raw)),name+' locked Content-Length is missing or incorrect'
    return raw,h
prefix='/v1/sources/phinix.poc'
c=json.loads((p/'catalog.json').read_text()); a=c['packages'][0]['artifact']; package=prefix+'/snapshots/'+c['snapshotId']+'/packages/phinix.poc.marker/1.0.0/'+a['sha256']+'/package'
if args.after_redeploy:
    check('package-after-redeploy',package,expected=p/'phinix-poc-marker-1.0.0.zip')
else:
    check('public-anonymous' if args.public else 'unauthenticated',prefix+'/stable',200 if args.public else 401,expected=p/'metadata/stable.json' if args.public else None,auth=False)
    raw,h=check('stable',prefix+'/stable',expected=p/'metadata/stable.json'); stable=json.loads(raw); snapshot=prefix+'/snapshots/'+stable['snapshotId']
    check('published',snapshot+'/published/'+stable['publishedSha256'],expected=p/'metadata/published'/(stable['snapshotId']+'.json'))
    check('catalog',snapshot+'/catalog/'+stable['catalogSha256'],expected=p/'catalog.json')
    for name in (['package-origin-first','package-origin-repeat'] if args.origin_only else ['package-existing-cache' if args.existing_cache else 'package-cold','package-warm']):
        check(name,package,expected=p/'phinix-poc-marker-1.0.0.zip'); time.sleep(2)
    check('stable-not-modified',prefix+'/stable',304,extra={'If-None-Match':h.get('ETag')})
    check('range-rejected',package,416,extra={'Range':'bytes=0-1'})
    check('query-rejected',prefix+'/stable?x=1',400)
print('Live byte and protocol assertions passed.',flush=True)
