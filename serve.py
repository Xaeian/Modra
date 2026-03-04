from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
from time import time
from api import Api
from xaeian import Color, Time
import threading

api = Api()

def log(method, path, code, ms):
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

  def _read_json(self):
    length = int(self.headers.get("Content-Length", 0))
    if not length: return {}
    return json.loads(self.rfile.read(length))

  def do_GET(self):
    start = time()
    if self.path == "/read": self.json_response(api.read()); return
    elif self.path == "/scan": self.json_response(api.scan()); return
    print(f"→ GET {self.path}")
    if self.path == "/status": self.json_response(api.status())
    elif self.path == "/info": self.json_response(api.info())
    elif self.path == "/serial": self.json_response(api.serial())
    elif self.path == "/config": self.json_response(api.config())
    elif self.path == "/disconnect": self.json_response(api.disconnect())
    elif self.path == "/sync": self.json_response(api.sync())
    elif self.path == "/days": self.json_response(api.days())
    else: super().do_GET()
    log("GET", self.path, self._code, (time() - start) * 1000)

  def do_POST(self):
    print(f"→ POST {self.path}")
    start = time()
    data = self._read_json()
    if self.path == "/connect":
      self.json_response(api.connect(data.get("port", "")))
    elif self.path == "/set_addr":
      self.json_response(api.set_addr(int(data.get("addr", 1))))
    elif self.path == "/set_serial":
      self.json_response(api.set_serial(data))
    elif self.path == "/set_config":
      self.json_response(api.set_config(data))
    elif self.path == "/scan_addrs":
      self.json_response(api.scan_addrs(data.get("addrs", [])))
    elif self.path == "/write":
      self.json_response(api.write(data))
    elif self.path == "/history":
      self.json_response(api.history(**data))
    elif self.path == "/history_range":
      self.json_response(api.history_range(**data))
    else:
      self.json_response({"error": "not found"})
    log("POST", self.path, self._code, (time() - start) * 1000)

  def do_OPTIONS(self):
    start = time()
    self._code = 204
    self.send_response(204)
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.send_header("Access-Control-Allow-Headers", "Content-Type")
    self.end_headers()
    log("OPTIONS", self.path, self._code, (time() - start) * 1000)

  def json_response(self, data):
    self._code = 200
    self.send_response(200)
    self.send_header("Content-Type", "application/json")
    self.end_headers()
    self.wfile.write(json.dumps(data).encode())

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
  print(f"Server stopped {Color.ORANGE}(Ctrl+C){Color.END}")