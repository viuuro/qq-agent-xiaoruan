#!/usr/bin/env python3
"""
qr-server.py —— 实时二维码网页（解决"发出去的图总是过期"的问题）

背景：NapCat 的登录二维码约每 2 分钟自动轮换，所以任何"发一次的图片"都很快失效。
      本服务在你打开的网页上**每次请求都现取现画**，按 F5 就是当前有效的码。

访问方式（在你自己的电脑上开隧道）：
    ssh -N -L 6098:127.0.0.1:6098 root@<服务器IP>
    浏览器打开  http://127.0.0.1:6098/

只监听 127.0.0.1，不对外网暴露。
"""

import io
import json
import os
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import qrcode
from qrcode.constants import ERROR_CORRECT_H

# ── 配置 ──────────────────────────────────────────────────────────────────────
WEBUI_PORT = 6099
WEBUI_TOKEN = (os.environ.get("WEBUI_TOKEN")
               or os.environ.get("NAPCAT_WEBUI_TOKEN") or "").strip()
if not WEBUI_TOKEN:
    import sys
    sys.exit("qr-server: 缺少环境变量 WEBUI_TOKEN（兼容 NAPCAT_WEBUI_TOKEN；请检查 systemd 的 EnvironmentFile）")
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 6098
CRED_CACHE = "/opt/qq/.qr-server-cred"


def webui_call(path, cred=None, use_cache=True):
    """调用 NapCat WebUI 接口。返回解析后的 JSON，失败返回 None。"""
    url = "http://127.0.0.1:%d/api%s" % (WEBUI_PORT, path)
    headers = {"Content-Type": "application/json"}
    if cred:
        headers["Authorization"] = "Bearer " + cred
    req = urllib.request.Request(url, data=b"{}", method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.load(resp)
    except Exception:
        return None


def get_credential(force=False):
    """取 WebUI 凭据：优先用缓存，失效（Unauthorized）才重新登录。

    注意 WebUI 登录接口有每分钟 3 次限流，所以必须缓存。
    """
    if not force and os.path.exists(CRED_CACHE):
        try:
            with open(CRED_CACHE, "r", encoding="utf-8") as fh:
                cached = fh.read().strip()
            if cached:
                probe = webui_call("/QQLogin/CheckLoginStatus", cached)
                if probe is not None and probe.get("code") != -1:
                    return cached
        except Exception:
            pass

    import hashlib
    h = hashlib.sha256((WEBUI_TOKEN + ".napcat").encode("utf-8")).hexdigest()
    url = "http://127.0.0.1:%d/api/auth/login" % WEBUI_PORT
    body = json.dumps({"hash": h}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.load(r)
        cred = (data.get("data") or {}).get("Credential")
        if cred:
            with open(CRED_CACHE, "w", encoding="utf-8") as fh:
                fh.write(cred)
            os.chmod(CRED_CACHE, 0o600)
            return cred
    except Exception:
        pass
    return None


def current_status():
    """返回 (qrcode_url, login_state, login_phase, extra_note)"""
    cred = get_credential()
    if not cred:
        return None, "unknown", "", "无法登录 NapCat WebUI（可能触发限流，稍等再刷新）"

    st = webui_call("/QQLogin/CheckLoginStatus", cred)
    if st is None:
        return None, "unknown", "", "NapCat WebUI 无响应"

    d = st.get("data") or {}
    if d.get("isLogin"):
        return None, "logged_in", d.get("loginPhase", ""), "账号已登录，不需要扫码"
    return d.get("qrcodeurl") or "", "not_logged_in", d.get("loginPhase", ""), d.get("loginError") or ""


PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QQ 登录二维码（实时）</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f1115; color:#e6e8eb;
         font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .card { background:#171a21; border:1px solid #262b36; border-radius:14px;
          padding:28px 32px; text-align:center; max-width:520px; }
  h1 { font-size:18px; margin:0 0 6px; font-weight:600; }
  .sub { color:#9aa4b2; font-size:13px; margin-bottom:18px; line-height:1.6; }
  img { width:340px; height:340px; image-rendering:pixelated;
        background:#fff; border-radius:10px; padding:10px; display:block; margin:0 auto; }
  .ok { color:#3fb950; font-size:15px; font-weight:600; padding:40px 0; }
  .warn { color:#d29922; font-size:13px; margin-top:14px; line-height:1.6; }
  .meta { color:#6b7280; font-size:12px; margin-top:16px; font-family:ui-monospace,monospace; }
  button { margin-top:18px; background:#2563eb; color:#fff; border:0; border-radius:8px;
           padding:10px 20px; font-size:14px; cursor:pointer; }
  button:hover { background:#1d4ed8; }
</style>
</head>
<body>
<div class="card">
  <h1>QQ 登录二维码</h1>
  <div class="sub">手机 QQ 扫码 → 手机上点「确认登录」。<br>
    此码由服务器实时生成，约每 2 分钟会自动轮换。</div>
  __BODY__
  <button onclick="location.reload()">刷新二维码</button>
  <div class="meta">__META__</div>
</div>
<script>
// 每 30 秒自动换一张新码，避免"打开页面忘了扫"导致又过期。
// 只换 img 的 src（加时间戳破缓存），不整页刷新，不会闪。
setInterval(function () {
  var img = document.querySelector('img[alt="登录二维码"]');
  if (img) {
    img.src = '/qr.png?t=' + Date.now();
    var m = document.querySelector('.meta');
    if (m) m.textContent = m.textContent.replace(/刷新于.*$/, '') + ' · 自动刷新于 ' + new Date().toLocaleTimeString();
  }
}, 30000);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/qr.png"):
            self.serve_qr()
            return

        url, state, phase, note = current_status()
        now = time.strftime("%Y-%m-%d %H:%M:%S")

        if state == "logged_in":
            body = '<div class="ok">✅ 账号已登录，无需扫码</div>'
            meta = "状态：logged_in · %s" % now
        elif url:
            body = '<img src="/qr.png?t=%d" alt="登录二维码">' % int(time.time())
            warn = '<div class="warn">%s</div>' % note if note else ""
            body += warn
            meta = "阶段：%s · 生成于 %s" % (phase or "waiting_qrcode", now)
        else:
            body = '<div class="warn">暂时拿不到二维码：%s</div>' % (note or "未知原因")
            meta = now

        html = PAGE.replace("__BODY__", body).replace("__META__", meta)
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def serve_qr(self):
        url, state, phase, note = current_status()
        if not url:
            self.send_error(404, "no qrcode available")
            return
        img = qrcode.QRCode(error_correction=ERROR_CORRECT_H, box_size=16, border=4)
        img.add_data(url)
        img.make(fit=True)
        pic = img.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        pic.save(buf, format="PNG")
        data = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        # 保持安静，避免刷日志
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print("qr-server listening on http://%s:%d/" % (LISTEN_HOST, LISTEN_PORT), flush=True)
    srv.serve_forever()
