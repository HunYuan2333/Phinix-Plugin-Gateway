"""Exercise the real operator CLI against a local HTTP stub; no cloud credentials."""
import json,os,subprocess,sys,tempfile,threading,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ENTRY=dict(source='test.local',package='a',version='1.0.0',sha256='a'*64,sizeBytes=32,key='test.local/packages/a/1.0.0/'+'a'*64+'/package',state='uncertain',lease='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
SNAPSHOT=dict(schemaVersion=1,ok=True,requestId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',result=dict(meta=dict(epoch='test-epoch',period='test-period'),totals=dict(usedBytes=4096,reservedBytes=2080,rows=1),objects=[dict(entry=ENTRY,fingerprint='c'*64,active=False)],journal=[]))

class OperatorCliTests(unittest.TestCase):
 def setUp(self):
  self.directory=tempfile.TemporaryDirectory();self.path=Path(self.directory.name);self.calls=[]
  calls=self.calls;test=self;self.reply=None
  class Handler(BaseHTTPRequestHandler):
   def do_POST(inner):
    request=json.loads(inner.rfile.read(int(inner.headers['Content-Length'])));calls.append(request)
    result=SNAPSHOT if request['action']=='inspect' else dict(schemaVersion=1,ok=True,requestId=SNAPSHOT['requestId'],result=dict(state='verified',capacityReleased=False))
    status,result=test.reply or (200,result)
    raw=json.dumps(result).encode();inner.send_response(status);inner.send_header('Content-Type','application/json');inner.send_header('Content-Length',str(len(raw)));inner.end_headers();inner.wfile.write(raw)
   def log_message(self,*args):pass
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
 def tearDown(self):
  self.server.shutdown();self.server.server_close();self.thread.join();self.directory.cleanup()
 def command(self,*args,url=None):
  # A deliberately invalid external proxy must not affect loopback operator requests.
  env={**os.environ,'HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1','http_proxy':'http://127.0.0.1:1','https_proxy':'http://127.0.0.1:1'}
  return subprocess.run([sys.executable,str(ROOT/'ops/cache-ops.py'),'--url',url or f'http://127.0.0.1:{self.server.server_port}/operations','--epoch','test-epoch','--period','test-period',*map(str,args)],capture_output=True,text=True,timeout=8,env=env)
 def snapshot(self):
  path=self.path/'snapshot.json';path.write_text(json.dumps(SNAPSHOT));return path
 def test_inspection_exports_exclusively_and_bypasses_external_proxy(self):
  path=self.path/'captured.json';first=self.command('inspect','--output',path);self.assertEqual(first.returncode,0,first.stderr);self.assertEqual(json.loads(path.read_text()),SNAPSHOT)
  self.assertEqual(json.loads(first.stderr),dict(event='operations.waiting',action='inspect',httpTimeoutSeconds=45))
  if os.name!='nt':self.assertEqual(path.stat().st_mode&0o777,0o600)
  self.assertEqual(self.command('inspect','--output',path).returncode,1);self.assertEqual(json.loads(path.read_text()),SNAPSHOT);self.assertEqual(len(self.calls),2)
 def test_plan_makes_no_request_then_apply_pins_identity(self):
  path=self.snapshot();args=('confirm','--inspection',path,'--key',ENTRY['key']);plan=self.command(*args);self.assertEqual(plan.returncode,0,plan.stderr);self.assertEqual(self.calls,[]);self.assertIn('Plan only',plan.stdout)
  applied=self.command(*args,'--apply');self.assertEqual(applied.returncode,0,applied.stderr);self.assertEqual(len(self.calls),1);sent=self.calls[0]['input'];self.assertEqual(sent['lease'],ENTRY['lease']);self.assertEqual(sent['fingerprint'],'c'*64);self.assertEqual(sent['entry']['sha256'],ENTRY['sha256'])
 def test_external_target_or_mismatched_snapshot_is_rejected_without_request(self):
  self.assertEqual(self.command('inspect','--output',self.path/'bad.json',url='http://example.com/operations').returncode,1)
  path=self.snapshot();bad=json.loads(path.read_text());bad['result']['meta']['epoch']='wrong';path.write_text(json.dumps(bad))
  self.assertEqual(self.command('confirm','--inspection',path,'--key',ENTRY['key'],'--apply').returncode,1);self.assertEqual(self.calls,[])
 def test_oversized_snapshot_is_rejected_without_request(self):
  path=self.path/'large.json';path.write_bytes(b' '* (1024*1024+1));self.assertEqual(self.command('confirm','--inspection',path,'--key',ENTRY['key'],'--apply').returncode,1);self.assertEqual(self.calls,[])

 def test_bridge_timeout_keeps_http_status_request_id_and_no_export(self):
  self.reply=(503,dict(schemaVersion=1,ok=False,code='OperationsRpcTimeout',requestId=SNAPSHOT['requestId']))
  path=self.path/'timeout.json';result=self.command('inspect','--output',path)
  self.assertEqual(result.returncode,1);self.assertEqual(result.stdout,'');self.assertFalse(path.exists());self.assertEqual(len(self.calls),1)
  waiting,failure=map(json.loads,result.stderr.splitlines())
  self.assertEqual(waiting,dict(event='operations.waiting',action='inspect',httpTimeoutSeconds=45))
  self.assertEqual(failure,dict(code='OperationsRpcTimeout',requestId=SNAPSHOT['requestId'],status=503))

if __name__=='__main__':unittest.main()
