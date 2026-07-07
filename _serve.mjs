import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname } from 'path';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.pdf':'application/pdf' };
createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  try {
    const buf = await readFile('.' + p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(8123, () => console.log('http://localhost:8123'));
