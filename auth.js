// 浏览器端只负责表单与请求；密码校验和数据库操作在 server.js 中。
const overlay = document.querySelector('#auth-overlay');
const form = document.querySelector('#auth-form');
const errorText = document.querySelector('#auth-error');
let mode = 'login';

function showUser(user) {
  overlay.hidden = Boolean(user);
  document.querySelector('#account-status').textContent = user ? `已登录 · ${user.username}` : '尚未登录';
  document.querySelector('#account-name').textContent = user ? `用户名：${user.username}` : '尚未登录';
  if (!user) document.querySelector('#username').focus();
  window.dispatchEvent(new CustomEvent('pixel-auth', { detail: { user } }));
}

async function request(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  errorText.textContent = '';
  const button = document.querySelector('#auth-submit');
  button.disabled = true;
  try {
    const result = await request(`/api/${mode}`, {
      username: document.querySelector('#username').value,
      password: document.querySelector('#password').value
    });
    document.querySelector('#password').value = '';
    showUser(result.user);
  } catch (error) {
    errorText.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#auth-switch').addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login';
  document.querySelector('#auth-title').textContent = mode === 'login' ? '登录账号' : '创建账号';
  document.querySelector('#auth-submit').textContent = mode === 'login' ? '登录' : '注册并进入';
  document.querySelector('#auth-switch').textContent = mode === 'login' ? '没有账号？去注册' : '已有账号？去登录';
  document.querySelector('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  errorText.textContent = '';
});

document.querySelector('#logout').addEventListener('click', async () => {
  await request('/api/logout', {});
  showUser(null);
});

fetch('/api/me').then(response => response.json()).then(result => showUser(result.user))
  .catch(() => { errorText.textContent = '无法连接服务器，请通过本地服务器地址打开页面。'; showUser(null); });
