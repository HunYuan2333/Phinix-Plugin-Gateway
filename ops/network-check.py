#!/usr/bin/env python3
"""Unauthenticated fixed PoC endpoint probe; no RPC, R2 or credential inspection."""
import json
import re
import urllib.error
import urllib.request

TARGET = 'https://phinix-plugin-repository-poc.zydyouxiang.workers.dev/diagnostic'
LIMIT = 4096


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(mode, opener, identify_client=True):
    result = dict(mode=mode)
    try:
        try:
            headers = {'User-Agent': 'Phinix-PluginStore-NetworkCheck/1', 'Accept': 'application/json'} if identify_client else {}
            response = opener.open(urllib.request.Request(TARGET, headers=headers), timeout=8)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result['status'] = response.getcode()
            for header, key, pattern in [
                ('Server', 'server', r'[A-Za-z0-9 ._/-]{1,128}'),
                ('CF-Ray', 'cfRay', r'[A-Za-z0-9-]{1,64}'),
                ('Content-Type', 'contentType', r'[A-Za-z0-9 ;=._/-]{1,128}'),
                ('X-Phinix-Request-Id', 'requestId', r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'),
            ]:
                value = response.headers.get(header, '')
                if re.fullmatch(pattern, value):
                    result[key] = value
            raw = response.read(LIMIT + 1)
            result['bodyTruncated'] = len(raw) > LIMIT
            if len(raw) <= LIMIT:
                cloudflare_code = re.search(rb'error code:\s*([0-9]{3,5})\b', raw, re.I)
                if cloudflare_code:
                    result['cloudflareErrorCode'] = int(cloudflare_code.group(1))
                try:
                    body = json.loads(raw)
                    code = body.get('code') if isinstance(body, dict) else None
                    if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Za-z0-9]{0,63}', code):
                        result['code'] = code
                except (ValueError, UnicodeError):
                    pass
    except Exception as error:
        reason = getattr(error, 'reason', error)
        result['error'] = type(reason).__name__
        if isinstance(getattr(reason, 'errno', None), int):
            result['errno'] = reason.errno
        tunnel = re.search(r'Tunnel connection failed: ([0-9]{3})\b', str(reason))
        if tunnel:
            result['proxyTunnelStatus'] = int(tunnel.group(1))
    return result


def main():
    for mode, handlers, identify_client in [
        ('environment-proxy-default-agent', [], False),
        ('environment-proxy', [], True),
        ('direct', [urllib.request.ProxyHandler({})], True),
    ]:
        print(json.dumps(dict(mode=mode, event='network.probe_started', socketTimeoutSeconds=8)), flush=True)
        result = probe(mode, urllib.request.build_opener(NoRedirect(), *handlers), identify_client)
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
