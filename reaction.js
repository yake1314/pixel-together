// 浏览器收到服务器事件后，所有人各自在自己的屏幕上播放同一动作。
const effectsCanvas = document.querySelector('#effects');
const effects = effectsCanvas.getContext('2d');
effects.imageSmoothingEnabled = false;
const reactionMessage = document.querySelector('#reaction-message');
const reactionButtons = {
  tomato: document.querySelector('#tomato-button'),
  money: document.querySelector('#money-button')
};
let eventStream = null;
let hasImage = false;
let particles = [];
const localCooldownUntil = { tomato: 0, money: 0 };

window.updateReactionCounts = counts => {
  hasImage = true;
  document.querySelector('#tomato-count').textContent = counts.tomato;
  document.querySelector('#money-count').textContent = counts.money;
  for (const [kind, button] of Object.entries(reactionButtons)) button.disabled = Date.now() < localCooldownUntil[kind];
  if (reactionMessage.textContent === '上传图片后可以评价') reactionMessage.textContent = '选一个动作评价这张图';
};

function pixel(x, y, size, color) {
  effects.fillStyle = color;
  effects.fillRect(Math.round(x), Math.round(y), size, size);
}

function tomatoSprite(x, y, scale = 3) {
  const rows = ['..GG....','.GRRG...','RRRRRR..','RRRRRRR.','RRRRRRR.','.RRRRR..','..RRR...'];
  rows.forEach((row, yy) => [...row].forEach((cell, xx) => {
    if (cell !== '.') pixel(x + xx * scale, y + yy * scale, scale, cell === 'G' ? '#4a9b52' : cell === 'R' ? '#e84d42' : '#ba342f');
  }));
}

function moneySprite(x, y, scale = 2) {
  pixel(x, y, 22 * scale, '#244b37');
  pixel(x + 2 * scale, y + 2 * scale, 18 * scale, '#91c983');
  pixel(x + 9 * scale, y + 3 * scale, 5 * scale, '#34634a');
  pixel(x + 9 * scale, y + 10 * scale, 5 * scale, '#34634a');
  pixel(x + 7 * scale, y + 7 * scale, 9 * scale, '#c9e9a6');
}

function startTomato(event) {
  particles.push({ type: 'flying-tomato', start: performance.now(), x: event.x * 640, y: event.y * 400 });
}

function startMoney() {
  const now = performance.now();
  for (let i = 0; i < 22; i++) particles.push({ type: 'bill', start: now + i * 60,
    x: 30 + Math.random() * 560, y: -50 - Math.random() * 130,
    speed: 70 + Math.random() * 85, sway: Math.random() * 6, phase: Math.random() * 6.28 });
}

function animate(now) {
  effects.clearRect(0, 0, 640, 400);
  const next = [];
  for (const part of particles) {
    const age = (now - part.start) / 1000;
    if (age < 0) { next.push(part); continue; }
    if (part.type === 'flying-tomato') {
      if (age < 0.46) {
        const t = age / 0.46;
        tomatoSprite(20 + (part.x - 20) * t, 350 + (part.y - 350) * t - 110 * Math.sin(Math.PI * t));
        next.push(part);
      } else {
        // 命中后分裂为方形红色碎片，模拟像素西红柿炸开。
        for (let i = 0; i < 14; i++) next.push({ type: 'splat', start: now,
          x: part.x, y: part.y, vx: Math.cos(i * 0.45) * (45 + i % 4 * 17),
          vy: Math.sin(i * 0.45) * (45 + i % 3 * 20) });
      }
    } else if (part.type === 'splat') {
      if (age < 0.7) { pixel(part.x + part.vx * age, part.y + part.vy * age + 65 * age * age, 5 + (age < .15 ? 3 : 0), age < .35 ? '#e84d42' : '#b93830'); next.push(part); }
    } else if (part.type === 'bill') {
      const y = part.y + part.speed * age;
      if (y < 430) { moneySprite(part.x + Math.sin(age * 4 + part.phase) * (10 + part.sway), y); next.push(part); }
    }
  }
  particles = next;
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function connectEvents() {
  if (eventStream) return;
  eventStream = new EventSource('/api/events');
  eventStream.addEventListener('image-changed', () => window.refreshImageState?.());
  eventStream.addEventListener('reaction', message => {
    const event = JSON.parse(message.data);
    if (event.imageId !== window.getCurrentImageId?.()) return;
    window.updateReactionCounts(event.counts);
    reactionMessage.textContent = `${event.username} ${event.kind === 'tomato' ? '扔了西红柿' : '撒了纸币'}`;
    if (event.kind === 'tomato') startTomato(event); else startMoney();
  });
}
window.addEventListener('pixel-auth', event => {
  if (event.detail.user) connectEvents();
  else if (eventStream) { eventStream.close(); eventStream = null; hasImage = false;
    for (const button of Object.values(reactionButtons)) button.disabled = true; }
});

for (const [kind, button] of Object.entries(reactionButtons)) {
  button.addEventListener('click', async () => {
    if (!hasImage) return;
    localCooldownUntil[kind] = kind === 'money' ? Date.now() + 2000 : 0;
    button.disabled = true;
    try {
      const response = await fetch('/api/react', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, imageId: window.getCurrentImageId() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '评价失败');
      button.disabled = kind === 'money';
      if (kind === 'money') setTimeout(() => { button.disabled = false; }, 2000);
    } catch (error) { reactionMessage.textContent = error.message; localCooldownUntil[kind] = 0; button.disabled = false; }
  });
}
