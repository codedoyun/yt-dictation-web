# 테스트용 정적 서버 (영상 탐색을 위해 Range 요청 지원)
import http.server, os, sys, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        rng = self.headers.get('Range')
        path = self.translate_path(self.path.split('?')[0])
        if not rng or not os.path.isfile(path):
            return super().do_GET()
        data = open(path, 'rb').read()
        m = re.match(r'bytes=(\d+)-(\d*)', rng)
        a = int(m.group(1)); z = int(m.group(2)) if m.group(2) else len(data) - 1
        chunk = data[a:z + 1]
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {a}-{z}/{len(data)}')
        self.send_header('Content-Length', str(len(chunk)))
        self.end_headers(); self.wfile.write(chunk)

http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
