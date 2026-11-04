// 第二阶段：一个最小 HTTP 后端。只使用 Node.js 内置模块，便于逐行学习。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'pixel-room.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reaction_counts (
    image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
    tomato INTEGER NOT NULL DEFAULT 0,
    money INTEGER NOT NULL DEFAULT 0
  );
`);

const attempts = new Map();
const reactionCooldowns = new Map();
const liveClients = new Set();
const sessionSeconds = 7 * 24 * 60 * 60;
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/auth.css': ['auth.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/auth.js': ['auth.js', 'text/javascript; charset=utf-8'],
  '/image.js': ['image.js', 'text/javascript; charset=utf-8'],
  '/image.css': ['image.css', 'text/css; charset=utf-8'],
  '/reaction.js': ['reaction.js', 'text/javascript; charset=utf-8'],
  '/reaction.css': ['reaction.css', 'text/css; charset=utf-8']
};

function broadcast(type, value) {
  const packet = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of liveClients) client.write(packet);
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) { reject(new Error('请求内容过长')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('请求格式错误')); }
    });
    req.on('error', reject);
  });
}

function readImageJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) { reject(new Error('上传内容过长')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('上传格式错误')); }
    });
    req.on('error', reject);
  });
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function currentUser(req) {
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('session='));
  if (!cookie) return null;
  const token = cookie.slice('session='.length);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return db.prepare(`SELECT users.id, users.username, users.role FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1`).get(
    crypto.createHash('sha256').update(token).digest('hex'), Date.now()
  ) || null;
}

function makeSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, Date.now() + sessionSeconds * 1000);
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return { 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionSeconds}${secure}` };
}

function limited(req) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  if (recent.length >= 20) return true;
  recent.push(now);
  attempts.set(key, recent);
  return false;
}

async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && files[url.pathname]) {
    const [name, type] = files[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(__dirname, name)).pipe(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    return json(res, 200, { user: currentUser(req) });
  }
  if (req.method === 'GET' && url.pathname === '/api/image-state') {
    if (!currentUser(req)) return json(res, 401, { error: '请先登录' });
    const image = db.prepare(`SELECT images.id, images.created_at_ms, users.username
      FROM images JOIN users ON users.id = images.user_id ORDER BY images.id DESC LIMIT 1`).get();
    const counts = image ? db.prepare('SELECT tomato, money FROM reaction_counts WHERE image_id = ?').get(image.id) : null;
    return json(res, 200, { image: image ? { id: image.id, username: image.username, url: `/api/images/${image.id}`, counts: counts || { tomato: 0, money: 0 } } : null,
      serverTime: Date.now(), nextUploadAt: image ? image.created_at_ms + 60000 : 0 });
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!currentUser(req)) return json(res, 401, { error: '请先登录' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(': connected\n\n');
    liveClients.add(res);
    req.on('close', () => liveClients.delete(res));
    return;
  }
  if (req.method === 'GET' && /^\/api\/images\/\d+$/.test(url.pathname)) {
    if (!currentUser(req)) return json(res, 401, { error: '请先登录' });
    const id = Number(url.pathname.split('/').pop());
    const image = db.prepare('SELECT filename, mime FROM images WHERE id = ?').get(id);
    if (!image) return json(res, 404, { error: '图片不存在' });
    res.writeHead(200, { 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(path.join(dataDir, image.filename)).pipe(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/upload-image') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '请先登录' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      return json(res, 403, { error: '请求来源不正确' });
    }
    const latest = db.prepare('SELECT created_at_ms FROM images ORDER BY id DESC LIMIT 1').get();
    if (latest && Date.now() < latest.created_at_ms + 60000) return json(res, 429, { error: '全站上传冷却中，请等待倒计时结束' });
    const body = await readImageJson(req);
    const latestAfterRead = db.prepare('SELECT created_at_ms FROM images ORDER BY id DESC LIMIT 1').get();
    if (latestAfterRead && Date.now() < latestAfterRead.created_at_ms + 60000) return json(res, 429, { error: '全站上传冷却中，请等待倒计时结束' });
    const match = typeof body.image === 'string' && body.image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return json(res, 400, { error: '请选择 PNG、JPEG 或 WebP 图片' });
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 2 * 1024 * 1024 || bytes.length < 12) return json(res, 400, { error: '图片须小于 2 MB' });
    const kind = match[1];
    const valid = kind === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : kind === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) return json(res, 400, { error: '图片内容与格式不符' });
    const filename = `${crypto.randomBytes(16).toString('hex')}.${kind === 'jpeg' ? 'jpg' : kind}`;
    fs.writeFileSync(path.join(dataDir, filename), bytes, { flag: 'wx' });
    const now = Date.now();
    const result = db.prepare('INSERT INTO images (user_id, filename, mime, created_at_ms) VALUES (?, ?, ?, ?)').run(user.id, filename, `image/${kind}`, now);
    broadcast('image-changed', { imageId: Number(result.lastInsertRowid) });
    return json(res, 201, { id: Number(result.lastInsertRowid), nextUploadAt: now + 60000 });
  }
  if (req.method === 'POST' && url.pathname === '/api/react') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '请先登录' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      return json(res, 403, { error: '请求来源不正确' });
    }
    const body = await readJson(req);
    if (!['tomato', 'money'].includes(body.kind)) return json(res, 400, { error: '未知评价类型' });
    const image = db.prepare('SELECT id FROM images ORDER BY id DESC LIMIT 1').get();
    if (!image || image.id !== body.imageId) return json(res, 409, { error: '图片已更新，请稍后重试' });
    const key = `${user.id}:${body.kind}`;
    const now = Date.now();
    const recent = (reactionCooldowns.get(key) || []).filter(time => now - time < (body.kind === 'tomato' ? 1000 : 2000));
    const limit = body.kind === 'tomato' ? 3 : 1;
    if (recent.length >= limit) return json(res, 429, { error: body.kind === 'tomato' ? '西红柿每秒最多扔 3 次' : '纸币每 2 秒最多撒 1 次' });
    recent.push(now);
    reactionCooldowns.set(key, recent);
    db.prepare('INSERT OR IGNORE INTO reaction_counts (image_id) VALUES (?)').run(image.id);
    db.prepare(`UPDATE reaction_counts SET ${body.kind} = ${body.kind} + 1 WHERE image_id = ?`).run(image.id);
    const counts = db.prepare('SELECT tomato, money FROM reaction_counts WHERE image_id = ?').get(image.id);
    const event = { imageId: image.id, kind: body.kind, username: user.username, counts,
      x: 0.25 + Math.random() * 0.5, y: 0.25 + Math.random() * 0.45 };
    broadcast('reaction', event);
    return json(res, 200, { counts });
  }
  if (req.method === 'POST' && ['/api/register', '/api/login', '/api/logout'].includes(url.pathname)) {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      return json(res, 403, { error: '请求来源不正确' });
    }
    if (url.pathname === '/api/logout') {
      const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('session='));
      if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(cookie.slice(8)).digest('hex'));
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (limited(req)) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || [...username].length >= 20 || /[\x00-\x1f\x7f]/.test(username) || password.length < 8 || password.length > 128) {
      return json(res, 400, { error: '用户名须少于20字，密码须为8到128个字符' });
    }
    if (url.pathname === '/api/register') {
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) return json(res, 409, { error: '用户名已被使用' });
      const salt = crypto.randomBytes(16).toString('hex');
      const result = db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').run(username, passwordHash(password, salt), salt);
      return json(res, 201, { user: { id: Number(result.lastInsertRowid), username, role: 'user' } }, makeSession(res, Number(result.lastInsertRowid)));
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    const hash = passwordHash(password, user?.salt || '00000000000000000000000000000000');
    if (!user || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'))) {
      return json(res, 401, { error: '用户名或密码错误' });
    }
    return json(res, 200, { user: { id: user.id, username: user.username, role: user.role } }, makeSession(res, user.id));
  }
  json(res, 404, { error: '页面或接口不存在' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: '服务器发生错误' });
  });
});
server.listen(port, host, () => console.log(`像素同画室运行在 http://${host}:${port}`));
