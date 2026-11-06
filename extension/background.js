// service worker：持有 API Key、调用视觉判分接口、抓取跨域图片
importScripts('rubric-core.js', 'rubric-chem-q16.js', 'rubric-yw-translate.js', 'rubric-q19.js', 'rubrics.js', 'llm.js');

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeoutMs: 120000,
  maxEdge: 1600,
  thinking: 'off',
  rubric: 'chem-q16',
  customRubrics: [],
  autoSubmit: false,
  countdownSec: 3,
  minConfidence: 0.6,
  autoNext: false
};

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return Object.assign({}, DEFAULTS, stored);
}

function clientFor(cfg) {
  return globalThis.createLlmClient({
    baseUrl: cfg.baseUrl || DEFAULTS.baseUrl,
    getKey: () => cfg.apiKey,
    timeoutMs: cfg.timeoutMs || DEFAULTS.timeoutMs,
    log: (...a) => console.log('[llm]', ...a)
  });
}

async function runGrade(input) {
  const cfg = await getConfig();
  if (!cfg.apiKey) throw new Error('还没有填写 API Key：点浏览器右上角扩展图标 → 设置，粘贴 sk- 开头的密钥后保存。');
  const client = clientFor(cfg);
  let img;
  if (input.base64) img = await normalize(input.base64, input.mediaType, cfg.maxEdge);
  else if (input.url) { const raw = await fetchImageAsBase64(input.url); img = await normalize(raw.base64, raw.mediaType, cfg.maxEdge); }
  else throw new Error('没有收到答题卡图片');
  const rub = globalThis.RUBS.get(cfg.rubric);
  if (!rub) throw new Error('未知细则：' + cfg.rubric);
  const references = await resolveReferences(rub, cfg);
  const res = await client.judge({
    rubric: rub, imageBase64: img.base64, mediaType: img.mediaType,
    model: cfg.model, thinking: cfg.thinking, references: references
  });
  return {
    ok: !!(res.parse && res.parse.ok),
    verdict: res.parse && res.parse.verdict ? res.parse.verdict : null,
    issues: res.parse ? res.parse.issues : ['无结果'],
    rawText: res.rawText, usage: res.usage, model: res.model,
    elapsedMs: res.elapsedMs, imageKb: Math.round(img.bytes / 1024)
  };
}

// 统一压到长边 maxEdge 的 JPEG，省流量也省 token
async function normalize(base64, mediaType, maxEdge) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType || 'image/png' })); }
  catch (e) { return { base64: base64, mediaType: mediaType || 'image/png', bytes: bytes.length }; }
  const limit = Number(maxEdge) > 0 ? Number(maxEdge) : 1600;
  const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const out = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; const CHUNK = 0x8000;
  for (let i = 0; i < out.length; i += CHUNK) bin += String.fromCharCode.apply(null, out.subarray(i, i + CHUNK));
  return { base64: btoa(bin), mediaType: 'image/jpeg', bytes: out.length };
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!res.ok) throw new Error('取图失败 HTTP ' + res.status);
  const blob = await res.blob();
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = ''; const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return { base64: btoa(bin), mediaType: blob.type || 'image/png', bytes: bytes.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => sendResponse(p);
  (async () => {
    try {
      const cfg = await getConfig();
      switch (msg && msg.type) {
        case 'getConfig':
          if (globalThis.RUBS.setCustom) globalThis.RUBS.setCustom(cfg.customRubrics || []);
          return reply({ ok: true, rubrics: globalThis.RUBS.list(), config: Object.assign({}, cfg, { apiKey: cfg.apiKey ? '已设置（' + cfg.apiKey.slice(0, 7) + '…）' : '' }) });
        case 'setConfig': {
          const patch = Object.assign({}, msg.patch || {});
          if (typeof patch.apiKey === 'string') { if (!patch.apiKey.trim()) delete patch.apiKey; else patch.apiKey = patch.apiKey.trim(); }
          if ('apiKey' in patch === false && msg.patch && 'apiKey' in msg.patch) patch.apiKey = '';
          for (const k of ['timeoutMs', 'maxEdge']) if (patch[k] !== undefined) patch[k] = Number(patch[k]) || DEFAULTS[k];
          if (patch.countdownSec !== undefined) patch.countdownSec = Math.max(0, Math.min(30, Number(patch.countdownSec) || 0));
          if (patch.minConfidence !== undefined) patch.minConfidence = Math.max(0, Math.min(1, Number(patch.minConfidence) || 0));
          for (const k of ['autoSubmit', 'autoNext']) if (patch[k] !== undefined) patch[k] = !!patch[k];
          await chrome.storage.local.set(patch);
          return reply({ ok: true });
        }
        case 'clearKey': await chrome.storage.local.remove('apiKey'); return reply({ ok: true });
        case 'grade': return reply(await runGrade(msg));
        case 'captureArea': return reply(await captureArea(msg.rect, msg.dpr, sender));
        case 'testConnection': return reply(Object.assign({ ok: true }, await clientFor(cfg).ping()));
        default: return reply({ ok: false, error: '未知消息：' + (msg && msg.type) });
      }
    } catch (e) {
      return reply({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage(); });

// 把细则里声明的参考结构图解析成 base64（内置图来自扩展资源，自定义图是 data URL）
const assetCache = {};
async function assetBase64(path) {
  if (assetCache[path]) return assetCache[path];
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error('读不到参考图 ' + path);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = ''; const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  assetCache[path] = { base64: btoa(bin), mediaType: 'image/png' };
  return assetCache[path];
}
async function resolveReferences(rub, cfg) {
  const images = {};
  ((cfg && cfg.rubricImages) || []).forEach(it => { if (it && it.key && it.dataUrl) images[it.key] = it.dataUrl; });
  const out = [];
  for (const b of rub.BLANKS) {
    if (!b.standardImage) continue;
    try {
      if (b.standardImage.indexOf('data:') === 0) {
        const parts = b.standardImage.split(',');
        out.push({ label: b.label, base64: parts[1], mediaType: (parts[0].split(';')[0].replace('data:', '')) || 'image/png' });
      } else if (images[b.standardImage]) {
        const parts = images[b.standardImage].split(',');
        out.push({ label: b.label, base64: parts[1], mediaType: (parts[0].split(';')[0].replace('data:', '')) || 'image/png' });
      } else {
        const a = await assetBase64(b.standardImage);
        out.push({ label: b.label, base64: a.base64, mediaType: a.mediaType });
      }
    } catch (e) { console.warn('[阅卷助手] 参考图跳过：' + b.standardImage + ' ' + e.message); }
  }
  return out;
}

// 卷面 canvas 被跨域污染时的兜底：截当前可见标签页，再按元素矩形裁切
async function captureArea(rect, dpr, sender) {
  const tab = sender && sender.tab;
  const winId = tab ? tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width / (tab ? await pageWidth(tab.id) : bmp.width);
  const s2 = Number(dpr) > 0 ? Number(dpr) : 1;
  const k = isFinite(scale) && scale > 0 ? scale : s2;
  const x = Math.max(0, Math.round(rect.left * k));
  const y = Math.max(0, Math.round(rect.top * k));
  const w = Math.min(bmp.width - x, Math.round(rect.width * k));
  const h = Math.min(bmp.height - y, Math.round(rect.height * k));
  if (w < 8 || h < 8) throw new Error('截屏区域无效（卷面可能不在可视范围）');
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = ''; const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return { ok: true, base64: btoa(bin), mediaType: 'image/png', w: w, h: h };
}
async function pageWidth(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: () => window.innerWidth });
    return res && res.result ? res.result : 0;
  } catch (e) { return 0; }
}
