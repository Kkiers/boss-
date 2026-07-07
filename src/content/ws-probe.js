// ═══════════════════════════════════════════════════════════════════
// WS 诊断探针 — MAIN world + document_start，在 BOSS 建 WebSocket 前 hook
// 记录每次 send 的 readyState/visibilityState + close/error 事件，写 DOM 属性
// 经 osascript 读 data-ws-probe 取证；纯诊断，不改 BOSS 行为
// ═══════════════════════════════════════════════════════════════════
(function () {
  if (window.__ztWsProbe) return;
  window.__ztWsProbe = true;
  var log = [];
  var sockets = 0;
  function flush() {
    try {
      document.documentElement.setAttribute('data-ws-probe', JSON.stringify({
        n: log.length, sockets: sockets, tail: log.slice(-50),
      }));
    } catch (e) {}
  }
  function rec(o) {
    o.t = Date.now();
    o.vis = document.visibilityState;
    log.push(o);
    if (log.length > 400) log.shift();
    flush();
  }
  var OWS = window.WebSocket;
  function Hooked(url, proto) {
    var ws = proto ? new OWS(url, proto) : new OWS(url);
    var id = sockets++;
    rec({ k: 'open', id: id, url: String(url).slice(0, 80) });
    var oSend = ws.send;
    ws.send = function (d) {
      var len = 0;
      try { len = (d && (d.byteLength || d.length || d.size)) || 0; } catch (e) {}
      rec({ k: 'send', id: id, len: len, rs: ws.readyState });
      try {
        return oSend.apply(ws, arguments);
      } catch (e) {
        rec({ k: 'send_err', id: id, err: String(e && e.message) });
        throw e;
      }
    };
    ws.addEventListener('message', function () { rec({ k: 'recv', id: id }); });
    ws.addEventListener('close', function (e) { rec({ k: 'close', id: id, code: e.code }); });
    ws.addEventListener('error', function () { rec({ k: 'error', id: id }); });
    return ws;
  }
  Hooked.prototype = OWS.prototype;
  Hooked.CONNECTING = 0; Hooked.OPEN = 1; Hooked.CLOSING = 2; Hooked.CLOSED = 3;
  window.WebSocket = Hooked;
  rec({ k: 'probe_installed' });
})();
