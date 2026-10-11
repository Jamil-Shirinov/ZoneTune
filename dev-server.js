// Local dev server for ZoneTune. Serves the same files Firebase Hosting deploys
// (the "hosting" section of firebase.json) with no dependencies to install:
//
//   node dev-server.js              → http://127.0.0.1:8080
//   PORT=3000 node dev-server.js    → another port
//
// Spotify doesn't accept "localhost" redirect URIs, only the loopback IP, so the
// site lives at 127.0.0.1 and anything else (e.g. localhost) is redirected there.
// Spotify login needs http://127.0.0.1:<port>/ listed under Redirect URIs in the
// app's settings at https://developer.spotify.com/dashboard.
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const ORIGIN = `http://${HOST}:${PORT}`;

const { hosting } = JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase.json'), 'utf8'));
const ROOT = path.resolve(__dirname, hosting.public);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
};

// firebase.json "ignore" globs as regexes, so nothing is served locally that
// wouldn't be deployed (dotfiles, actualProjectStuff/, files/, ...)
const IGNORED = (hosting.ignore || []).map(glob => new RegExp('^' + glob
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\/|\*\*|\*/g, m => m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : '[^/]*') + '$'));

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function resolveFile(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  let file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null; // ../ escapes
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  const relPosix = path.relative(ROOT, file).split(path.sep).join('/');
  if (IGNORED.some(re => re.test(relPosix))) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const server = http.createServer((req, res) => {
  // Spotify sends the login back to the exact origin it was started from, and
  // the tokens live in that origin's sessionStorage, so keep everyone on one
  if (req.headers.host !== `${HOST}:${PORT}`) {
    res.writeHead(302, { Location: ORIGIN + req.url });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, 'Method not allowed');
  }

  const { pathname } = new URL(req.url, ORIGIN); // query (e.g. Spotify's ?code=) is ignored
  let file;
  try { file = resolveFile(pathname); } catch (e) { return send(res, 400, 'Bad request'); }
  // Log the path only: the Spotify callback's query string carries the auth code
  res.on('finish', () => console.log(`${res.statusCode} ${req.method} ${pathname}`));
  if (!file) return send(res, 404, 'Not found');

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store', // edits show up on a plain reload
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try another one: PORT=${PORT + 1} node dev-server.js`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`ZoneTune running at ${ORIGIN}`);
  console.log(`Spotify login needs ${ORIGIN}/ under Redirect URIs at https://developer.spotify.com/dashboard`);
});
