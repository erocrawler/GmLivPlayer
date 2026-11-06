#!/usr/bin/env python3
"""Client for the render service in this directory (server.mjs). Stdlib only.

env:
  RENDER_URL              default http://127.0.0.1:27662
  RENDER_KEY_FILE         default ./.render_key  (never print it)
  CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   optional, only if the endpoint sits behind Cloudflare Access (the x-render-key header is the auth)

usage:
  python3 render-client.py upload vrm   /path/arona_toon3c.vrm
  python3 render-client.py upload audio /path/line.wav          # 16-bit PCM WAV
  python3 render-client.py upload bg    /path/office.jpg
  python3 render-client.py render job.json out.mp4              # waits, downloads
  python3 render-client.py info
job.json example: see job-example.json (portrait: view {zoom 0.9, y -0.1}, amb 0)
"""
import json, os, sys, time, urllib.request, urllib.error
URL = os.environ.get("RENDER_URL", "http://127.0.0.1:27662").rstrip("/")
KEYF = os.environ.get("RENDER_KEY_FILE", ".render_key")
def hdr(extra=None):
    h = {"x-render-key": open(KEYF).read().strip(), "user-agent": "render-client/1"}
    if os.environ.get("CF_ACCESS_CLIENT_ID"):
        h["CF-Access-Client-Id"] = os.environ["CF_ACCESS_CLIENT_ID"]; h["CF-Access-Client-Secret"] = os.environ["CF_ACCESS_CLIENT_SECRET"]
    h.update(extra or {}); return h
def call(method, path, data=None, headers=None, timeout=600):
    req = urllib.request.Request(URL + path, data=data, method=method, headers=hdr(headers))
    try: return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e: sys.exit(f"HTTP {e.code}: {e.read()[:300].decode('utf-8','replace')}")
def upload(kind, file):
    with open(file, "rb") as f: r = call("PUT", f"/assets/{kind}/{os.path.basename(file)}", f.read(), {"content-type": "application/octet-stream"})
    print(r.read().decode())
def render(job_file, out):
    r = json.load(call("POST", "/jobs", open(job_file, "rb").read(), {"content-type": "application/json"})); jid = r["id"]; print("job", jid)
    while True:
        s = json.load(call("GET", f"/jobs/{jid}"))
        if s["state"] in ("done", "error"): break
        print(f'  {s["state"]} {s.get("progress",0):.0%}', end="\r"); time.sleep(2)
    print(json.dumps(s))
    if s["state"] == "error": sys.exit(1)
    open(out, "wb").write(call("GET", f"/jobs/{jid}/video.mp4").read()); print("saved", out)
if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["upload"] and len(a) == 3: upload(a[1], a[2])
    elif a[:1] == ["render"] and len(a) == 3: render(a[1], a[2])
    elif a[:1] == ["info"]: print(call("GET", "/info").read().decode())
    else: sys.exit(__doc__)
