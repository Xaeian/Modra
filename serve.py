"""
HTTP front for Api: routes GET/POST → Api methods, serves static frontend
files. CORS open, port 8000. Counterpart to the pywebview launcher in api.py.
"""

import json
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from xaeian import Color, Time
from api import Api, link

api = Api()

GET_ROUTES = {
  "/info": api.info,
  "/serial": api.serial,
  "/sync": api.sync,
  "/view_get": api.view_get,
}

POST_ROUTES = {
  "/connect": api.connect,
  "/disconnect": api.disconnect,
  "/set_addr": api.set_addr,
  "/set_serial": api.set_serial,
  "/set_map": api.set_map,
  "/write": api.write,
  "/scan_addrs": api.scan_addrs,
  "/view_set": api.view_set,
  "/delete_database": api.delete_database,
}

MUTE = {"/read", "/scan"}

def log(method, path, code, dt):
  ms = dt.total_seconds() * 1000
  if code >= 500: col = Color.RED
  elif code >= 400: col = Color.YELLOW
  elif code >= 200: col = Color.GREEN
  else: col = Color.GREY
  ts = Time().to("%H:%M:%S")
  print(f"← {method} {path} {col}{code}{Color.END} {Color.GREY}[{ts}] {ms:.0f}ms{Color.END}")

class Handler(SimpleHTTPRequestHandler):
  def log_message(self, *args): pass

  def end_headers(self):
    self.send_header("Access-Control-Allow-Origin", "*")
    super().end_headers()

  def _read_json(self) -> dict|None:
    length = int(self.headers.get("Content-Length", 0))
    if not length: return {}
    try: return json.loads(self.rfile.read(length))
    except (json.JSONDecodeError, UnicodeDecodeError): return None

  def _json(self, data):
    self._code = 200
    self.send_response(200)
    self.send_header("Content-Type", "application/json")
    self.end_headers()
    self.wfile.write(json.dumps(data).encode())

  def _error(self, code, msg):
    self._code = code
    self.send_response(code)
    self.send_header("Content-Type", "application/json")
    self.end_headers()
    self.wfile.write(json.dumps({"error": msg}).encode())

  def do_GET(self):
    start = Time()
    mute = self.path in MUTE
    if not mute: print(f"→ GET {self.path}")
    # /read and /scan bypass the route table and return early - muted hot paths.
    if self.path == "/read":
      self._json(api.read()); return
    elif self.path == "/scan":
      self._json(api.scan()); return
    fn = GET_ROUTES.get(self.path)
    if fn: self._json(fn())
    else: super().do_GET()
    if not mute: log("GET", self.path, self._code, Time() - start)

  def do_POST(self):
    start = Time()
    data = self._read_json()
    if data is None:
      self._error(400, "invalid JSON")
      log("POST", self.path, 400, Time() - start)
      return
    mute = self.path in MUTE
    if not mute: print(f"→ POST {self.path}")
    if self.path == "/read":
      self._json(api.read(data)); return
    fn = POST_ROUTES.get(self.path)
    if fn: self._json(fn(data))
    else: self._error(404, "not found")
    if not mute: log("POST", self.path, self._code, Time() - start)

  def do_OPTIONS(self):
    self._code = 204
    self.send_response(204)
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.send_header("Access-Control-Allow-Headers", "Content-Type")
    self.end_headers()

  def send_response(self, code, message=None):
    self._code = code
    super().send_response(code, message)

if __name__ == "__main__":
  port = 8000
  print(f"Server at {Color.BLUE}http://localhost:{port}{Color.END}")
  server = ThreadingHTTPServer(("", port), Handler)
  t = threading.Thread(target=server.serve_forever)
  t.daemon = True
  t.start()
  try: input()
  except KeyboardInterrupt: pass
  link.close()
  print(f"Server stopped {Color.ORANGE}(Ctrl+C){Color.END}")