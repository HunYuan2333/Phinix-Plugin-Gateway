"""Check diagnostic output bounds and redaction without cloud or local ports."""
import errno
import importlib.util
import io
import json
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('network_check', Path(__file__).resolve().parents[1] / 'ops/network-check.py')
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class NetworkCheckTests(unittest.TestCase):
    def test_http_error_reports_worker_markers_without_body_or_auth_headers(self):
        body = json.dumps(dict(code='PocAccessDenied', secret='private-body-value')).encode()
        error = urllib.error.HTTPError(network.TARGET, 401, 'Unauthorized', {
            'Server': 'cloudflare', 'CF-Ray': '1234abcd-SIN',
            'Content-Type': 'application/json; charset=utf-8',
            'X-Phinix-Request-Id': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'Authorization': 'Bearer private-header-value',
        }, io.BytesIO(body))
        opener = Mock(); opener.open.side_effect = error
        result = network.probe('environment-proxy', opener)
        self.assertEqual(result['status'], 401)
        self.assertEqual(result['code'], 'PocAccessDenied')
        self.assertEqual(result['requestId'], 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        self.assertFalse(result['bodyTruncated'])
        self.assertNotIn('private', json.dumps(result))
        opener.open.assert_called_once()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, network.TARGET)
        self.assertEqual(request.get_header('User-agent'), 'Phinix-PluginStore-NetworkCheck/1')
        self.assertEqual(opener.open.call_args.kwargs, dict(timeout=8))

    def test_default_agent_cloudflare_error_is_reported_without_raw_body(self):
        error = urllib.error.HTTPError(network.TARGET, 403, 'Forbidden', {}, io.BytesIO(b'error code: 1010\nprivate-detail'))
        opener = Mock(); opener.open.side_effect = error
        self.assertEqual(network.probe('environment-proxy-default-agent', opener, False), dict(mode='environment-proxy-default-agent', status=403, bodyTruncated=False, cloudflareErrorCode=1010))
        self.assertIsNone(opener.open.call_args.args[0].get_header('User-agent'))

    def test_network_errno_and_proxy_tunnel_rejection_are_distinguishable(self):
        opener = Mock(); opener.open.side_effect = urllib.error.URLError(OSError(errno.ENETUNREACH, 'sensitive detail'))
        self.assertEqual(network.probe('direct', opener), dict(mode='direct', error='OSError', errno=errno.ENETUNREACH))
        opener.open.side_effect = urllib.error.URLError(OSError('Tunnel connection failed: 403 Forbidden private-url'))
        self.assertEqual(network.probe('environment-proxy', opener), dict(mode='environment-proxy', error='OSError', proxyTunnelStatus=403))

    def test_response_body_read_is_bounded(self):
        response = Mock(); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        response.getcode.return_value = 403; response.headers = {}; response.read.return_value = b'x' * (network.LIMIT + 1)
        opener = Mock(); opener.open.return_value = response
        self.assertEqual(network.probe('direct', opener), dict(mode='direct', status=403, bodyTruncated=True))
        response.read.assert_called_once_with(network.LIMIT + 1)

    def test_redirect_is_not_followed(self):
        self.assertIsNone(network.NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://other.example/'))


if __name__ == '__main__':
    unittest.main()
