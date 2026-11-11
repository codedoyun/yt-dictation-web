# 가짜 모바일 유튜브 서버 (userscript 테스트용)
#  /setmode?m=ok|pot|none   ok: 자막 주소 직접 요청 성공 / pot: 직접 요청은 빈 응답, 스크립트(get_transcript)는 성공
#                           none: 둘 다 실패, 플레이어가 자막을 켜야만 받을 수 있음
import http.server, json, os, sys, re
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = {'m': 'ok'}
CAPS = json.dumps({"events": [
    {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "Hello, world!"}]},
    {"tStartMs": 4000, "dDurationMs": 2000, "segs": [{"utf8": "I don't know."}]},
    {"tStartMs": 8000, "dDurationMs": 2000, "segs": [{"utf8": "It's a well-known fact."}]},
]})
TRANSCRIPT = json.dumps({"actions": [{"updateEngagementPanelAction": {"content": {"transcriptRenderer": {"content": {
    "transcriptSearchPanelRenderer": {"body": {"transcriptSegmentListRenderer": {"initialSegments": [
        {"transcriptSegmentRenderer": {"startMs": "1000", "endMs": "3000", "snippet": {"runs": [{"text": "Hello, world!"}]}}},
        {"transcriptSegmentRenderer": {"startMs": "4000", "endMs": "6000", "snippet": {"runs": [{"text": "I don't know."}]}}},
        {"transcriptSegmentRenderer": {"startMs": "8000", "endMs": "10000", "snippet": {"runs": [{"text": "It's a well-known fact."}]}}},
    ]}}}}}}}}]})

CAPS_KO = json.dumps({"events": [
    {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "안녕, 세상아!"}]},
    {"tStartMs": 4000, "dDurationMs": 2000, "segs": [{"utf8": "모르겠어."}]},
    {"tStartMs": 8000, "dDurationMs": 2000, "segs": [{"utf8": "잘 알려진 사실이야."}]},
]})
PR = {"videoDetails": {"videoId": "TESTVIDEO01"}, "captions": {"playerCaptionsTracklistRenderer": {"captionTracks": [
    {"baseUrl": "/api/timedtext?v=TESTVIDEO01&lang=ko", "languageCode": "ko"},
    {"baseUrl": "/api/timedtext?v=TESTVIDEO01&lang=en&kind=asr", "languageCode": "en", "kind": "asr"},
    {"baseUrl": "/api/timedtext?v=TESTVIDEO01&lang=en", "languageCode": "en"},
]}}}
INITIAL_DATA = json.dumps({"engagementPanels": [{"x": {"continuation": {"getTranscriptEndpoint": {"params": "CgtURVNU"}}}}]})
INITIAL_DATA_HEX = ''.join('\\x%02x' % ord(c) if c in '{}"\'\\<>=&' else c for c in INITIAL_DATA)

def page():
    return f"""<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<meta name="apple-itunes-app" content="app-id=544007664">
<style>body{{margin:0;background:#fff;font-family:sans-serif}} #player-container-id{{position:sticky;top:0;width:100%;aspect-ratio:16/9;background:#000;z-index:5}}
video{{width:100%;height:100%}} .content{{height:2000px;padding:10px}}</style></head><body>
<script nonce="n1">var ytInitialPlayerResponse = {json.dumps(PR)};</script>
<script nonce="n2">window.ytcfg = (function(){{var d={{}};return {{set:function(o){{Object.assign(d,o)}},get:function(k){{return d[k]}}}}}})();
ytcfg.set({{"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CONTEXT":{{"client":{{"clientName":"MWEB","clientVersion":"2.20251101.01.00","hl":"en"}}}}}});</script>
<script nonce="n3">var ytInitialData = '{INITIAL_DATA_HEX}';</script>
<div id="player-container-id"><div id="movie_player" class="html5-video-player">
  <video class="video-stream html5-main-video" src="/video.webm" muted playsinline></video>
  <div class="ytp-caption-window-container" style="position:absolute;top:0;color:#fff">YT CAPTION</div>
  <button class="ytp-subtitles-button" style="position:absolute;right:0;top:0" onclick="var x=new XMLHttpRequest();x.open('GET','/api/timedtext?v=TESTVIDEO01&lang=en&tlang=vi&fmt=srv3&pot=abc');x.send();">CC</button>
</div></div>
<div class="content">Title and comments…</div>
<script nonce="n4">
  var p = document.getElementById('movie_player'); var mod = false;
  p.getPlayerResponse = function(){{ return ytInitialPlayerResponse; }};
  p.loadModule = function(){{ mod = true; }};
  p.getOption = function(m,k){{ return mod && k==='tracklist' ? [{{languageCode:'en',kind:''}}] : null; }};
  p.setOption = function(m,k,t){{ window.captionSet = t; var x = new XMLHttpRequest(); x.open('GET','/api/timedtext?v=TESTVIDEO01&lang=en&fmt=json3&pot=abc'); x.send(); }};
</script>
</body></html>"""

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def out(self, code, body, ctype, extra=None):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        u = urlparse(self.path); n = int(self.headers.get('Content-Length') or 0); body = json.loads(self.rfile.read(n) or b'{}')
        if u.path == '/youtubei/v1/get_transcript':
            ok = MODE['m'] in ('ok', 'pot') and body.get('params') == 'CgtURVNU' and body.get('context', {}).get('client', {}).get('clientName') == 'MWEB'
            return self.out(200, TRANSCRIPT, 'application/json') if ok else self.out(400, '{"error":{}}', 'application/json')
        self.out(404, 'nf', 'text/plain')
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == '/setmode': MODE['m'] = q['m'][0]; return self.out(200, 'ok', 'text/plain')
        if u.path == '/watch':
            # 실제 유튜브처럼 Trusted Types 강제 (innerHTML 쓰면 오류)
            return self.out(200, page(), 'text/html; charset=utf-8', {'Content-Security-Policy': "require-trusted-types-for 'script'"})
        if u.path == '/api/timedtext':
            if MODE['m'] == 'ok' or 'pot' in q: return self.out(200, CAPS_KO if 'ko' in (q.get('tlang', [''])[0], q.get('lang', [''])[0]) else CAPS, 'application/json')
            return self.out(200, '', 'application/json')
        if u.path == '/video.webm':
            data = open(os.path.join(HERE, 'video.webm'), 'rb').read()
            rng = self.headers.get('Range')
            if rng:
                m = re.match(r'bytes=(\d+)-(\d*)', rng); a = int(m.group(1)); z = int(m.group(2)) if m.group(2) else len(data) - 1
                return self.out(206, data[a:z + 1], 'video/webm', {'Accept-Ranges': 'bytes', 'Content-Range': f'bytes {a}-{z}/{len(data)}'})
            return self.out(200, data, 'video/webm', {'Accept-Ranges': 'bytes'})
        self.out(404, 'nf', 'text/plain')

http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
