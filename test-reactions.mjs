// 可复现的接口小实验：在独立测试数据库中运行，避免改动真实图片和评价。
const base = process.env.TEST_BASE || 'http://127.0.0.1:3002';
const suffix = Math.random().toString(36).slice(2, 8);
async function register(username) {
  const response = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'TestPass123!' }) });
  if (!response.ok) throw new Error(`注册失败：${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}
async function post(path, cookie, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const a = await register(`a_${suffix}`);
const b = await register(`b_${suffix}`);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
const uploaded = await post('/api/upload-image', a, { image: png });
if (uploaded.status !== 201) throw new Error(`上传失败：${uploaded.status}`);
const controller = new AbortController();
const stream = await fetch(`${base}/api/events`, { headers: { Cookie: b }, signal: controller.signal });
if (stream.status !== 200) throw new Error('第二个用户无法订阅实时事件');
const read = stream.body.getReader();
await read.read(); // 服务器先发连接成功注释
const result = await post('/api/react', a, { kind: 'tomato', imageId: uploaded.data.id });
if (result.status !== 200 || result.data.counts.tomato !== 1) throw new Error('评价计数错误');
const event = new TextDecoder().decode((await read.read()).value);
if (!event.includes('event: reaction') || !event.includes('"tomato":1')) throw new Error('第二个用户没有收到实时评价');
const second = await post('/api/react', a, { kind: 'tomato', imageId: uploaded.data.id });
const third = await post('/api/react', a, { kind: 'tomato', imageId: uploaded.data.id });
const tooSoon = await post('/api/react', a, { kind: 'tomato', imageId: uploaded.data.id });
if (second.status !== 200 || third.status !== 200 || third.data.counts.tomato !== 3 || tooSoon.status !== 429) throw new Error('西红柿每秒 3 次限频失效');
controller.abort();
console.log('通过：两个账号、上传、实时事件、评价计数、西红柿每秒 3 次限频');
