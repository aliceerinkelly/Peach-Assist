import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const root = normalize(process.argv[2] || '.');
const port = Number(process.argv[3] || 8099);

const types = {
  '.apk': 'application/vnd.android.package-archive',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

http
  .createServer(async (req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const file = join(root, name || 'index.html');
    if (!normalize(file).startsWith(root)) {
      res.writeHead(403).end('no');
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': String(body.length),
      });
      res.end(body);
      console.log(new Date().toISOString(), req.socket.remoteAddress, 200, name || "index.html", body.length);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      console.log(new Date().toISOString(), req.socket.remoteAddress, 404, name);
    }
  })
  .listen(port, '0.0.0.0', () => console.log('serving', root, 'on port', port));
