// 第一阶段：全部逻辑只在浏览器运行。后续会把绘画事件交给服务器同步和保存。
const canvas = document.querySelector('#board');
const ctx = canvas.getContext('2d');
const colorInput = document.querySelector('#color');
const sizeInput = document.querySelector('#size');
const penButton = document.querySelector('#pen');
const eraserButton = document.querySelector('#eraser');

ctx.imageSmoothingEnabled = false;
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, canvas.width, canvas.height);
const baseCanvas = document.createElement('canvas');
baseCanvas.width = canvas.width;
baseCanvas.height = canvas.height;
const baseCtx = baseCanvas.getContext('2d');
baseCtx.drawImage(canvas, 0, 0);

let drawing = false;
let erasing = false;
let previousPoint = null;
const undoStack = [];
const maxUndoSteps = 30;

// 图片是新的底图；换图时清空本地笔画，后续阶段再把笔画交给服务器保存。
window.showSharedImage = async function (url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  ctx.drawImage(image, Math.round((canvas.width - width) / 2), Math.round((canvas.height - height) / 2), width, height);
  baseCtx.drawImage(canvas, 0, 0);
  undoStack.length = 0;
};

function pointFromEvent(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width),
    y: Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)
  };
}

// 用小方块连成线段，画笔也会呈现像素感。
function drawSegment(start, end) {
  const size = Number(sizeInput.value);
  const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y), 1);
  ctx.fillStyle = colorInput.value;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(start.x + (end.x - start.x) * i / steps);
    const y = Math.round(start.y + (end.y - start.y) * i / steps);
    const left = Math.floor(x / 2) * 2 - size / 2;
    const top = Math.floor(y / 2) * 2 - size / 2;
    if (erasing) ctx.drawImage(baseCanvas, left, top, size, size, left, top, size, size);
    else ctx.fillRect(left, top, size, size);
  }
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  // 一次按下到松开算一步；只保存有限步数，避免画布快照无限占用内存。
  undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (undoStack.length > maxUndoSteps) undoStack.shift();
  drawing = true;
  canvas.setPointerCapture(event.pointerId);
  previousPoint = pointFromEvent(event);
  drawSegment(previousPoint, previousPoint);
});
canvas.addEventListener('pointermove', event => {
  if (!drawing) return;
  const point = pointFromEvent(event);
  drawSegment(previousPoint, point);
  previousPoint = point;
});
function stopDrawing() { drawing = false; previousPoint = null; }
canvas.addEventListener('pointerup', stopDrawing);
canvas.addEventListener('pointercancel', stopDrawing);

document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.shiftKey) return;
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable]')) return;
  if (drawing || undoStack.length === 0) return;
  event.preventDefault();
  ctx.putImageData(undoStack.pop(), 0, 0);
});

function selectTool(useEraser) {
  erasing = useEraser;
  penButton.classList.toggle('active', !erasing);
  eraserButton.classList.toggle('active', erasing);
  penButton.setAttribute('aria-pressed', String(!erasing));
  eraserButton.setAttribute('aria-pressed', String(erasing));
}
penButton.addEventListener('click', () => selectTool(false));
eraserButton.addEventListener('click', () => selectTool(true));
colorInput.addEventListener('input', () => { document.querySelector('#color-value').textContent = colorInput.value.toUpperCase(); });
sizeInput.addEventListener('input', () => { document.querySelector('#size-value').textContent = `${sizeInput.value} px`; });
