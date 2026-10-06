import contextlib
import hashlib
import io
import json
import runpy
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('live-poc.py')


class Response(io.BytesIO):
    def __init__(self, raw, status=200):
        super().__init__(raw)
        self.code = status
        self.headers = Message()
        self.headers['ETag'] = '"fixture"'
        self.headers['Content-Length'] = str(len(raw))
        self.headers['X-Phinix-Request-Id'] = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'


class PublicProbeTests(unittest.TestCase):
    def fixtures(self, root):
        payload = b'controlled payload'
        catalog = json.dumps({'snapshotId': '1' * 40, 'packages': [{'artifact': {'sha256': hashlib.sha256(payload).hexdigest()}}]}).encode()
        stable = json.dumps({'snapshotId': '1' * 40, 'publishedSha256': '2' * 64, 'catalogSha256': '3' * 64}).encode()
        (root / 'metadata/published').mkdir(parents=True)
        (root / 'metadata/stable.json').write_bytes(stable)
        (root / ('metadata/published/' + '1' * 40 + '.json')).write_bytes(b'{}')
        (root / 'catalog.json').write_bytes(catalog)
        (root / 'phinix-poc-marker-1.0.0.zip').write_bytes(payload)
        return stable, catalog, payload

    def run_probe(self, root, opener, *extra, output=None):
        output = output if output is not None else io.StringIO()
        with patch('sys.argv', [str(SCRIPT), '--endpoint', 'https://fixture.example.test', '--directory', str(root),
                                '--public', '--origin-only', '--direct', *extra]), \
             patch('urllib.request.build_opener', return_value=opener), patch('time.sleep'), contextlib.redirect_stdout(output):
            runpy.run_path(str(SCRIPT), run_name='__main__')
        return output.getvalue()

    def test_public_probe_does_not_read_secret_or_send_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stable, catalog, payload = self.fixtures(root)
            class Opener:
                calls = 0
                def open(self, request, timeout):
                    self.calls += 1
                    self_test.assertFalse(request.has_header('Authorization'))
                    self_test.assertEqual(timeout, 45)
                    if request.has_header('Range'): return Response(b'{}', 416)
                    if '?' in request.full_url: return Response(b'{}', 400)
                    if request.has_header('If-none-match'): return Response(b'', 304)
                    if request.full_url.endswith('/stable'): return Response(stable)
                    if '/published/' in request.full_url: return Response(b'{}')
                    if '/catalog/' in request.full_url: return Response(catalog)
                    return Response(payload)
            self_test = self
            opener = Opener()
            self.run_probe(root, opener, '--require-package-length')
            self.assertEqual(opener.calls, 9)
            results = json.loads((root / 'live-results.json').read_text())
            self.assertEqual(results[0]['name'], 'public-anonymous')
            self.assertEqual([r['name'] for r in results if r['name'].startswith('package-')],
                             ['package-origin-first', 'package-origin-repeat'])
            self.assertFalse((root / 'secrets.json').exists())

    def test_network_error_exits_without_raw_error_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixtures(root)
            class Opener:
                def open(self, request, timeout): raise urllib.error.URLError(OSError(101, 'SECRET_NETWORK_ERROR'))
            output = io.StringIO()
            with self.assertRaises(SystemExit) as rejected:
                self.run_probe(root, Opener(), output=output)
            self.assertEqual(rejected.exception.code, 1)
            error = json.loads(output.getvalue())
            self.assertEqual(error['errorCode'], 'ProbeNetworkError')
            self.assertEqual(error['errno'], 101)
            self.assertNotIn('SECRET', output.getvalue())
            self.assertFalse((root / 'live-results.json').exists())

    def test_real_package_length_requirement_rejects_an_unframed_response(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stable, catalog, payload = self.fixtures(root)
            class Opener:
                def open(self, request, timeout):
                    if request.full_url.endswith('/stable'): return Response(stable)
                    if '/published/' in request.full_url: return Response(b'{}')
                    if '/catalog/' in request.full_url: return Response(catalog)
                    response = Response(payload)
                    del response.headers['Content-Length']
                    return response
            with self.assertRaisesRegex(AssertionError, 'Content-Length'):
                self.run_probe(root, Opener(), '--require-package-length')

    def test_cache_claims_cannot_be_combined_with_origin_only(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as rejected:
            self.run_probe(Path(directory), None, '--existing-cache')
        self.assertEqual(rejected.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
