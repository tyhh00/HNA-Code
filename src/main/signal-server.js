// Tiny localhost-only HTTP server that Claude Code hooks POST to.
// Bound to 127.0.0.1 with a per-launch random token so no other local process can spoof it.
const http = require('http');
const crypto = require('crypto');

function startSignalServer(onSignal) {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/signal')) {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy(); // basic flood guard
    });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body); } catch (_) {}
      if (!payload || payload.token !== token) {
        res.writeHead(403); res.end('bad token'); return;
      }
      try { onSignal(payload); } catch (_) {}
      res.writeHead(200); res.end('ok');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, token });
    });
  });
}

module.exports = { startSignalServer };
