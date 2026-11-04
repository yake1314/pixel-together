// 这一阶段用定时请求学习全站共享状态；下一阶段改为服务器主动推送。
const uploadButton = document.querySelector('#upload-button');
const imageFile = document.querySelector('#image-file');
const timer = document.querySelector('#upload-timer');
const message = document.querySelector('#upload-message');
let shownImageId = null;
let nextUploadAt = 0;
let serverOffset = 0;
let busy = false;

function updateCountdown() {
  const seconds = Math.max(0, Math.ceil((nextUploadAt - (Date.now() + serverOffset)) / 1000));
  timer.textContent = seconds ? `全站下一次上传：${seconds} 秒后` : '现在可以上传新图片';
  uploadButton.disabled = busy || seconds > 0 || !window.pixelUser;
}

async function refreshImageState() {
  try {
    const authResponse = await fetch('/api/me');
    const auth = await authResponse.json();
    window.pixelUser = auth.user;
    if (!auth.user) { timer.textContent = '登录后可以上传'; uploadButton.disabled = true; return; }
    const response = await fetch('/api/image-state');
    if (!response.ok) throw new Error('读取图片状态失败');
    const state = await response.json();
    serverOffset = state.serverTime - Date.now();
    nextUploadAt = state.nextUploadAt;
    updateCountdown();
    if (state.image && state.image.id !== shownImageId) {
      await window.showSharedImage(state.image.url);
      shownImageId = state.image.id;
      document.querySelector('#image-owner').textContent = `由 ${state.image.username} 上传`;
    }
    if (state.image) window.updateReactionCounts?.(state.image.counts);
  } catch (error) {
    message.textContent = error.message;
  }
}

uploadButton.addEventListener('click', async () => {
  const file = imageFile.files[0];
  if (!file) { message.textContent = '请先选择图片'; return; }
  if (file.size > 2 * 1024 * 1024) { message.textContent = '图片不能超过 2 MB'; return; }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { message.textContent = '只支持 PNG、JPEG、WebP'; return; }
  busy = true; updateCountdown(); message.textContent = '正在上传...';
  try {
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
    const response = await fetch('/api/upload-image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '上传失败');
    message.textContent = '上传成功，所有人即将看到这张图片。';
    imageFile.value = '';
    await refreshImageState();
  } catch (error) { message.textContent = error.message; }
  finally { busy = false; updateCountdown(); }
});

setInterval(updateCountdown, 250);
setInterval(refreshImageState, 3000);
refreshImageState();
window.refreshImageState = refreshImageState;
window.getCurrentImageId = () => shownImageId;
