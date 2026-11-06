// 注入到阅卷页面：识别按钮 + 结果面板 + 填分（绝不点击"提交分数"）
(function () {
  'use strict';
  const root = globalThis;
  if (window.__q16GraderLoaded) return;
  window.__q16GraderLoaded = true;

  const BAN_TEXT = /(提交|保存|确认|下一份|上一份|回评|撤销|批量)/;
  const state = { busy: false, submitting: false, last: null, locked: null, candidates: [], rub: null, cfg: null, pasteBase64: null, pasteArmed: false, cancelCountdown: null, countTimer: 0 };

  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r) => { if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message }); else resolve(r); }); }
    catch (e) { resolve({ ok: false, error: '扩展后台不可用，请刷新页面：' + e.message }); }
  });

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, '') : '');
  function all() { return Array.prototype.slice.call(document.querySelectorAll('body *')); }
  function findByText(exact) {
    return all().filter(el => {
      if (!visible(el)) return false;
      if (el.children.length > 2) return false;
      return txt(el) === exact;
    }).sort((a, b) => (a.textContent.length - b.textContent.length))[0] || null;
  }
  function clickTarget(el) {
    let cur = el;
    for (let i = 0; i < 5 && cur; i++) {
      const cs = getComputedStyle(cur);
      if (cs.cursor === 'pointer' || /^(A|BUTTON|LI|TD)$/.test(cur.tagName)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }
  function fireClick(el) {
    if (!el) return false;
    const target = clickTarget(el);
    if (BAN_TEXT.test(txt(target))) return false;
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  function findSubmitButton() {
    const direct = [].slice.call(document.querySelectorAll('.submit-btn')).filter(visible);
    return direct[0] || findByText('提交分数');
  }
  function isGradingPage() { return !!findSubmitButton(); }

  function imageCandidates() {
    const out = [];
    Array.prototype.forEach.call(document.querySelectorAll('img, canvas'), el => {
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 60000) return;
      let src = '';
      if (el.tagName === 'IMG') src = el.currentSrc || el.src || '';
      if (!src && el.tagName === 'CANVAS') { try { src = 'canvas'; } catch (e) { return; } }
      out.push({ el, src, area, rect: r });
    });
    Array.prototype.forEach.call(document.querySelectorAll('*'), el => {
      if (out.some(c => c.el === el) || !visible(el)) return;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return;
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (!m) return;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 60000) return;
      out.push({ el, src: m[1], area: r.width * r.height, rect: r });
    });
    out.sort((a, b) => b.area - a.area);
    return out.slice(0, 6);
  }

  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  function buildPanel() {
    const host = el('div', 'q16-host');
    host.innerHTML = [
      '<div class="q16-head"><span class="q16-title">阅卷助手</span><span class="q16-min" title="最小化">—</span></div>',
      '<div class="q16-body">',
      '  <div class="q16-row"><label>细则</label><select class="q16-rubsel"></select></div>',
      '  <div class="q16-row"><label>卷面</label><select class="q16-imgsel"></select><button class="q16-btn q16-refresh" title="重新扫描页面">刷新</button></div>',
      '  <div class="q16-probe"></div>',
      '  <div class="q16-row"><button class="q16-btn q16-primary q16-run">识别并判分 (Alt+1)</button><button class="q16-btn q16-paste" title="手动粘贴截图（图片跨域取不到时用）">粘贴截图</button></div>',
      '  <div class="q16-status">就绪</div>',
      '  <table class="q16-table"><thead><tr><th class="q16-col0">空</th><th>得分</th><th>识别到的作答</th></tr></thead><tbody></tbody></table>',
      '  <div class="q16-total">总分 <b class="q16-score">—</b> <span class="q16-full"></span></div>',
      '  <div class="q16-count" style="display:none"><span class="q16-count-txt"></span><i class="q16-count-bar"></i><button class="q16-btn q16-count-cancel">取消 (Esc)</button></div>',
      '  <div class="q16-row"><button class="q16-btn q16-fill" disabled>提交分值 (Alt+2)</button><button class="q16-btn q16-copy" disabled>复制</button></div>',
      '  <div class="q16-issues"></div>',
      '</div>'
    ].join('');
    const q = (sel) => host.querySelector(sel);
    const api = {
      host, status: q('.q16-status'), tbody: q('.q16-table tbody'), score: q('.q16-score'),
      run: q('.q16-run'), fill: q('.q16-fill'), copy: q('.q16-copy'), paste: q('.q16-paste'),
      imgsel: q('.q16-imgsel'), refresh: q('.q16-refresh'), issues: q('.q16-issues'), body: q('.q16-body'), probe: q('.q16-probe'),
      rubsel: q('.q16-rubsel'), title: q('.q16-title'), full: q('.q16-full'), col0: q('.q16-col0'),
      count: q('.q16-count'), countTxt: q('.q16-count-txt'), countBar: q('.q16-count-bar'), countCancel: q('.q16-count-cancel')
    };
    q('.q16-min').addEventListener('click', () => host.classList.toggle('q16-collapsed'));
    api.run.addEventListener('click', () => grade());
    api.fill.addEventListener('click', () => fillScore());
    api.copy.addEventListener('click', () => { if (state.last) navigator.clipboard.writeText(String(state.last.total)); });
    api.paste.addEventListener('click', () => armPaste());
    api.refresh.addEventListener('click', () => { scanImages(); setStatus('已重新扫描卷面'); });
    fillRubricChoices(api);
    api.rubsel.addEventListener('change', () => {
      state.rub = root.RUBS.get(api.rubsel.value);
      if (!state.rub) return;
      state.last = null; api.fill.disabled = true; api.copy.disabled = true; api.score.textContent = '—';
      api.col0.textContent = state.rub.itemLabel;
      api.title.textContent = '阅卷助手 · ' + state.rub.name;
      api.full.textContent = '/ ' + state.rub.FULL_SCORE;
      send({ type: 'setConfig', patch: { rubric: api.rubsel.value } });
      setStatus('已切换到细则：' + state.rub.name);
    });
    api.imgsel.addEventListener('change', () => { state.pasteBase64 = null; setStatus('已选择页面图片 #' + api.imgsel.value); });
    makeDraggable(host, q('.q16-head'));
    document.documentElement.appendChild(host);
    return api;
  }

  function makeDraggable(host, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('q16-min')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
      host.style.right = 'auto'; host.style.bottom = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      host.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      host.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function fillRubricChoices(api) {
    const list = (root.RUBS && root.RUBS.list) ? root.RUBS.list() : [];
    api.rubsel.innerHTML = '';
    list.forEach(it => {
      const o = el('option'); o.value = it.id; o.textContent = it.name + '（满分' + it.fullScore + '）';
      if (state.rub && it.id === state.rub.id) o.selected = true;
      api.rubsel.appendChild(o);
    });
    if (!list.length) api.rubsel.innerHTML = '<option value="">没有加载任何细则</option>';
  }

  function showFatal(text) {
    if (ui) { setStatus(text, 'error'); return; }
    const host = el('div', 'q16-host');
    host.innerHTML = '<div class="q16-head"><span class="q16-title">阅卷助手</span><span class="q16-min">—</span></div>' +
      '<div class="q16-body"><div class="q16-status q16-error"></div></div>';
    document.documentElement.appendChild(host);
    host.querySelector('.q16-status').textContent = text;
    host.querySelector('.q16-min').addEventListener('click', () => host.classList.toggle('q16-collapsed'));
  }

  function setStatus(text, kind) {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.className = 'q16-status' + (kind ? ' q16-' + kind : '');
  }

  function canvasLayers() {
    if (root.PLATFORM && root.PLATFORM.findCanvasLayers) return root.PLATFORM.findCanvasLayers();
    return [].slice.call(document.querySelectorAll('canvas')).filter(visible);
  }

  // 卷面由 canvas 绘制：按顺序合成各图层，再裁到实际有墨迹的范围
  function captureCanvasByDraw() {
    const layers = canvasLayers();
    if (!layers.length) throw new Error('页面没有画布');
    const w = Math.max.apply(null, layers.map(function (c) { return c.width; }));
    const h = Math.max.apply(null, layers.map(function (c) { return c.height; }));
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    layers.forEach(function (c) { try { ctx.drawImage(c, 0, 0, c.width, c.height); } catch (e) { } });
    let crop = null, clipped = false;
    try {
      const d = ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const q = (y * w + x) * 4;
          if (d[q + 3] < 10) continue;
          if (d[q] > 240 && d[q + 1] > 240 && d[q + 2] > 240) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX > 0) {
        clipped = maxY >= h - 4 || maxX >= w - 4;
        crop = [Math.max(0, minX - 14), Math.max(0, minY - 14), Math.min(w, maxX + 14), Math.min(h, maxY + 14)];
      }
    } catch (e) { throw e; }
    let srcCanvas = out;
    if (crop) {
      const c2 = document.createElement('canvas');
      c2.width = crop[2] - crop[0]; c2.height = crop[3] - crop[1];
      c2.getContext('2d').drawImage(out, crop[0], crop[1], c2.width, c2.height, 0, 0, c2.width, c2.height);
      srcCanvas = c2;
    }
    const url = srcCanvas.toDataURL('image/png');
    if (url.indexOf('data:') !== 0) throw new Error('画布导出失败');
    return { base64: url.split(',')[1], mediaType: 'image/png', w: srcCanvas.width, h: srcCanvas.height, clipped: clipped };
  }


  function updateProbe() {
    if (!ui || !root.PLATFORM) return;
    const d = root.PLATFORM.detect();
    const nums = d.keypad.map(function (x) { return x.n; });
    const range = nums.length ? Math.min.apply(null, nums) + '–' + Math.max.apply(null, nums) + '（' + nums.length + '个）' : '未找到';
    ui.probe.textContent = '平台：' + (d.imageKind === 'canvas' ? '画布×' + d.canvas.length : (d.imageKind === 'img' ? '图片' : '无卷面')) +
      '｜分值 ' + range + '｜得分 ' + (d.score ? d.score.value : '—') + '｜密号 ' + (d.code || '—');
    ui.probe.title = '探测来源：' + (d.keypadSource || 'none');
  }

  function scanImages() {
    const list = [];
    if (canvasLayers().length) list.push({ kind: 'canvas', label: '画布卷面（' + canvasLayers().length + ' 层）' });
    imageCandidates().forEach(function (c, i) {
      const r = c.rect;
      list.push({ kind: 'img', el: c.el, src: c.src, rect: r, label: '图片 #' + (i + 1) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) });
    });
    state.candidates = list;
    if (!ui) return;
    ui.imgsel.innerHTML = '';
    list.forEach(function (c, i) {
      const o = el('option'); o.value = String(i); o.textContent = c.label;
      ui.imgsel.appendChild(o);
    });
    if (!list.length) {
      const o = el('option'); o.value = ''; o.textContent = '未发现卷面，请用粘贴截图'; ui.imgsel.appendChild(o);
    }
    updateProbe();
  }

  function renderVerdict(v, issues) {
    if (!ui) return;
    ui.tbody.innerHTML = '';
    v.blanks.forEach(b => {
      const tr = el('tr', b.score === 0 ? 'q16-zero' : (b.score < b.max ? 'q16-part' : ''));
      tr.title = '标准答案：' + b.standard + '\n判分依据：' + b.reason;
      tr.innerHTML = '<td>' + b.label + '</td><td>' + b.score + '/' + b.max + '</td><td>' +
        escapeHtml((b.raw || '（未作答）').slice(0, 28)) + '</td>';
      ui.tbody.appendChild(tr);
    });
    ui.score.textContent = String(v.total);
    ui.issues.innerHTML = (issues && issues.length ? '已校正：' + issues.map(escapeHtml).join('；') : '') +
      (v.confidence < 0.6 ? '<br><span class="q16-warn">识别置信度较低，建议人工复核</span>' : '');
    ui.full.textContent = '/ ' + v.fullScore;
    ui.fill.disabled = false;
    ui.copy.disabled = false;
    state.last = v;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function pageText() {
    const b = document.body;
    return String((b && (b.innerText || b.textContent)) || '');
  }

  function studentCode() {
    if (root.PLATFORM) {
      const code = root.PLATFORM.findCode([/密号[：:]?\s*([0-9A-Za-z][0-9A-Za-z\-]*)/, /试卷[号編编]?[：:]?\s*([0-9A-Za-z][0-9A-Za-z\-]*)/]);
      if (code) return code;
    }
    const m = pageText().match(/密号[^0-9]*([0-9][0-9\-]*)/);
    return m ? m[1] : '';
  }

  function gradedCount() {
    const m = pageText().match(/已评[^0-9]*([0-9]+)/);
    return m ? Number(m[1]) : null;
  }

  async function currentImagePayload() {
    if (state.pasteBase64) return { base64: state.pasteBase64, mediaType: state.pasteType || 'image/png' };
    const cand = state.candidates[Number(ui.imgsel.value)];
    if (!cand) throw new Error('没有可选的答题卡画面');
    if (cand.kind === 'canvas') {
      const shot = await captureCanvas();
      if (shot.clipped) setStatus('注意：卷面超出可视区域，只截到可见部分。建议滚动让整题可见后重试', 'warn');
      return shot;
    }
    if (/^data:/i.test(cand.src)) {
      const parts = cand.src.split(',');
      return { base64: parts[1], mediaType: (parts[0].split(';')[0].replace('data:', '')) || 'image/png' };
    }
    return { url: cand.src };
  }

  async function grade() {
    if (!ui || state.busy) return;
    state.busy = true;
    ui.run.disabled = true;
    const t0 = Date.now();
    const ticker = setInterval(() => setStatus('识别中… ' + Math.round((Date.now() - t0) / 1000) + 's'), 1000);
    try {
      const payload = await currentImagePayload();
      const res = await send(Object.assign({ type: 'grade' }, payload));
      if (!res || !res.ok) {
        setStatus('失败：' + ((res && res.error) || '未知错误'), 'error');
        return;
      }
      renderVerdict(res.verdict, res.issues);
      const usage = res.usage ? '，' + (res.usage.total_tokens || 0) + ' tokens' : '';
      setStatus('完成，用时 ' + (res.elapsedMs / 1000).toFixed(1) + 's，图片 ' + (res.imageKb || '?') + 'KB' + usage + (studentCode() ? '（密号 ' + studentCode() + '）' : ''), 'ok');
      state.locked = { code: pageIdentity(), rubricId: state.rub ? state.rub.id : '', total: res.verdict.total, at: Date.now() };
      logHistory(res.verdict);
      if (state.cfg && state.cfg.autoSubmit) submitScore(true);
    } catch (e) {
      setStatus('失败：' + e.message, 'error');
    } finally {
      clearInterval(ticker);
      ui.run.disabled = false;
      state.busy = false;
    }
  }

  async function logHistory(v) {
    const stored = await chrome.storage.local.get({ history: [] });
    const list = stored.history || [];
    list.unshift({ at: new Date().toISOString(), code: studentCode(), total: v.total, url: location.href });
    chrome.storage.local.set({ history: list.slice(0, 200) });
  }

  var ui = null;

  // 光大阅卷：分值按钮是 ul.scores > li（0~14）；找不到时退回通用扫描
  // 平台自适应：优先用探测到的分值按钮（ul.scores li / .level-item / 成组数字…）
  function keypadButtons() {
    const map = {};
    const found = root.PLATFORM ? root.PLATFORM.findKeypad() : { items: [] };
    const list = found.items.filter(function (x) { return root.PLATFORM.visible(x.el) && !(x.el.closest && x.el.closest('.q16-host')); });
    list.forEach(function (x) { const t = String(x.n); (map[t] = map[t] || []).push(x.el); });
    return map;
  }

  function keypadMax() {
    const map = keypadButtons();
    const nums = Object.keys(map).map(Number);
    return nums.length ? Math.max.apply(null, nums) : null;
  }

  function readScored() {
    if (root.PLATFORM) {
      const hit = root.PLATFORM.findScoreReader();
      if (hit) return hit.value;
    }
    const boxes = [].slice.call(document.querySelectorAll('div.fs')).filter(visible);
    for (const b of boxes) { const m = txt(b).match(/得分[：:](\d+)/); if (m) return Number(m[1]); }
    return null;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 页面身份：优先密号；没有密号的系统（如学科网）用"已批阅量"充当
  function pageIdentity() {
    const code = studentCode();
    const p = root.PLATFORM ? root.PLATFORM.findProgress() : null;
    const parts = [];
    if (code) parts.push(code);
    if (p && p.graded != null) parts.push('批阅' + p.graded);
    return parts.join('|');
  }

  function canvasUnionRect() {
    const cs = canvasLayers();
    const rects = cs.map(function (c) { return c.getBoundingClientRect(); }).filter(function (r) { return r.width > 8 && r.height > 8; });
    if (!rects.length) return null;
    const left = Math.min.apply(null, rects.map(function (r) { return r.left; }));
    const top = Math.min.apply(null, rects.map(function (r) { return r.top; }));
    const right = Math.max.apply(null, rects.map(function (r) { return r.right; }));
    const bottom = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  // 跨域画布无法导出（学科网就是），退回"截可见标签页 + 按矩形裁剪"
  async function captureCanvas() {
    try {
      return captureCanvasByDraw();
    } catch (e) {
      const rect = canvasUnionRect();
      if (!rect) throw e;
      const res = await send({ type: 'captureArea', rect: rect, dpr: window.devicePixelRatio || 1 });
      if (!res || !res.ok) throw new Error('画布跨域且截屏失败：' + ((res && res.error) || '未知'));
      return { base64: res.base64, mediaType: res.mediaType || 'image/png', w: res.w, h: res.h, clipped: false, viaShot: true };
    }
  }

  function submitButtonEl() {
    return root.PLATFORM ? root.PLATFORM.findSubmitButton() : null;
  }

  function clickSubmit(el) {
    if (!el) return false;
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  // 本系统点分值即提交，点错就是真实落库，所以宁可停手也不盲点
  function precheck() {
    const v = state.last;
    if (!v) return '还没有判分结果';
    if (!state.locked) return '缺少判分时的卷面信息，请重新判分';
    const code = pageIdentity();
    if (state.locked.code && code && state.locked.code !== code) {
      return '卷面已切换（判分时 ' + state.locked.code + '，现在 ' + code + '），已阻止提交，请重新判分';
    }
    if (state.locked.rubricId && state.rub && state.locked.rubricId !== state.rub.id) {
      return '判分之后切换了细则，已阻止提交，请重新判分';
    }
    const kmax = keypadMax();
    if (kmax !== null && v.total > kmax) return '判分 ' + v.total + ' 分超出页面分值按钮上限 ' + kmax + '，请核对细则与题目是否匹配';
    const hit = keypadButtons()[String(v.total)];
    if (!hit) return '页面上找不到分值按钮 ' + v.total + '，请手动点击';
    if (hit.length > 1) return '分值按钮 ' + v.total + ' 匹配到 ' + hit.length + ' 个，无法确定该点哪个';
    return null;
  }

  function hideCountdown() {
    clearTimeout(state.countTimer);
    state.countTimer = 0;
    if (ui) { ui.count.style.display = 'none'; ui.countBar.style.width = '0%'; }
  }

  function countdown(sec) {
    return new Promise(function (resolve) {
      if (!ui) return resolve(false);
      const endAt = Date.now() + sec * 1000;
      ui.count.style.display = 'flex';
      ui.countCancel.onclick = function () { if (state.cancelCountdown) state.cancelCountdown(); };
      const finish = function (cancelled) { state.cancelCountdown = null; hideCountdown(); resolve(cancelled); };
      state.cancelCountdown = function () { clearTimeout(state.countTimer); finish(true); };
      const tick = function () {
        const left = endAt - Date.now();
        if (left <= 0) { ui.countTxt.textContent = '提交中…'; ui.countBar.style.width = '100%'; return finish(false); }
        ui.countTxt.textContent = sec + ' 秒后自动提交：' + (left / 1000).toFixed(1) + 's';
        ui.countBar.style.width = Math.round(100 * (1 - left / (sec * 1000))) + '%';
        state.countTimer = setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function confirmSubmit(codeBefore, total) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(400);
      const codeNow = pageIdentity();
      if (codeBefore && codeNow && codeNow !== codeBefore) return { kind: 'advanced', codeNow: codeNow };
      if (readScored() === total) return { kind: 'filled', codeNow: codeNow };
    }
    return { kind: 'unknown', codeNow: pageIdentity() };
  }

  async function confirmSubmitClick(before) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(400);
      const now = pageIdentity();
      if (before && now && now !== before) return true;
      const sc = readScored();
      if (sc === null || sc === 0) return true;
    }
    return false;
  }

  function resetAfterSubmit() {
    state.last = null;
    state.locked = null;
    if (!ui) return;
    ui.tbody.innerHTML = '';
    ui.score.textContent = '—';
    ui.issues.innerHTML = '';
    ui.fill.disabled = true;
    ui.copy.disabled = true;
    scanImages();
  }

  async function submitScore(auto) {
    if (!ui || state.submitting) return;
    if (!state.last) { setStatus('还没有判分结果', 'error'); return; }
    const cfg = state.cfg || {};
    const total = state.last.total;
    if (auto) {
      const min = Number(cfg.minConfidence || 0);
      if (Number(state.last.confidence) < min) {
        setStatus('置信度 ' + state.last.confidence + ' 低于阈值 ' + min + '，已取消自动提交，请人工核对后点提交', 'warn');
        return;
      }
    }
    let stop;
    try { stop = precheck(); } catch (e) { setStatus('提交前校验出错：' + e.message, 'error'); return; }
    if (stop) { setStatus(stop, 'error'); return; }
    if (auto) {
      const sec = Number(cfg.countdownSec);
      if (sec > 0) { const cancelled = await countdown(sec); if (cancelled) { setStatus('已取消自动提交，可手动点提交', 'warn'); return; } }
      stop = precheck();
      if (stop) { setStatus('倒计时期间：' + stop, 'error'); return; }
    }
    state.submitting = true;
    try {
      const codeBefore = pageIdentity();
      if (!fireClick(keypadButtons()[String(total)][0])) {
        setStatus('分值按钮被安全规则拦截，未点击', 'error');
        return;
      }
      const out = await confirmSubmit(codeBefore, total);
      if (out.kind === 'advanced') {
        setStatus('已提交 ' + total + ' 分（' + (codeBefore || '本份') + '）→ 下一份 ' + (out.codeNow || '?'), 'ok');
        resetAfterSubmit();
        if (cfg.autoNext) grade();
        return;
      }
      if (out.kind === 'filled') {
        const btn = submitButtonEl();
        if (cfg.autoSubmit && btn) {
          const before = pageIdentity();
          setStatus('已填 ' + total + ' 分，正在提交…', 'warn');
          if (!clickSubmit(btn)) { setStatus('提交按钮点击失败', 'error'); return; }
          const done = await confirmSubmitClick(before);
          if (done) {
            setStatus('已提交 ' + total + ' 分（' + (before || '本份') + '）', 'ok');
            resetAfterSubmit();
            if (cfg.autoNext) grade();
          } else {
            setStatus('已点击提交分数，但未确认到结果，请人工核对', 'error');
          }
        } else if (btn) {
          setStatus('已填入 ' + total + ' 分，本平台需再点"提交分数"保存', 'warn');
        } else {
          setStatus('已填入 ' + total + ' 分，页面未显示提交按钮，请人工确认', 'warn');
        }
        return;
      }
      setStatus('已点击分值 ' + total + '，但未确认到提交结果，请人工核对当前页面', 'error');
    } catch (e) {
      setStatus('提交失败：' + e.message, 'error');
    } finally {
      state.submitting = false;
      hideCountdown();
    }
  }

  async function fillScore() { return submitScore(false); }

  function armPaste() {
    state.pasteArmed = true;
    setStatus('请按 Ctrl+V 粘贴答题卡截图', 'warn');
  }

  window.addEventListener('paste', (e) => {
    if (!state.pasteArmed || !e.clipboardData) return;
    const items = Array.prototype.slice.call(e.clipboardData.items || []);
    const hit = items.find(i => i.type && i.type.indexOf('image/') === 0);
    if (!hit) { setStatus('剪贴板里没有图片', 'error'); return; }
    const file = hit.getAsFile();
    const reader = new FileReader();
    reader.onload = () => {
      const parts = String(reader.result).split(',');
      state.pasteBase64 = parts[1];
      state.pasteType = (parts[0].match(/data:([^;]+)/) || [])[1] || 'image/png';
      state.pasteArmed = false;
      setStatus('已接收粘贴图片，点"识别并判分"');
    };
    reader.readAsDataURL(file);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.cancelCountdown) { e.preventDefault(); state.cancelCountdown(); return; }
    if (!e.altKey) return;
    if (e.key === '1') { e.preventDefault(); grade(); }
    if (e.key === '2') { e.preventDefault(); fillScore(); }
  }, true);

  async function boot() {
    if (ui) return true;
    if (!isGradingPage()) return false;
    if (!root.RUBS || !root.RUBS.get) { showFatal('细则脚本没加载成功。多半是扩展文件更新过：请到 chrome://extensions 点本扩展的刷新按钮，再刷新阅卷页面。'); return true; }
    const cfg = await send({ type: 'getConfig' });
    state.cfg = (cfg && cfg.ok && cfg.config) ? cfg.config : {};
    if (root.RUBS.setCustom) root.RUBS.setCustom(state.cfg.customRubrics || []);
    state.rub = root.RUBS.get(state.cfg.rubric) || root.RUBS.get(root.RUBS.DEFAULT_ID);
    if (!state.rub) { showFatal('后台没有返回可用细则（当前页面为 ' + location.host + '）。请在扩展设置页确认已填 API Key 并保存。'); return true; }
    ui = buildPanel();
    ui.col0.textContent = state.rub.itemLabel;
    ui.title.textContent = '阅卷助手 · ' + state.rub.name;
    ui.full.textContent = '/ ' + state.rub.FULL_SCORE;
    scanImages();
    setStatus('已就绪：' + state.rub.name + '（' + state.rub.RUBRIC_VERSION + '）');
    return true;
  }

  let tries = 0, running = false;
  const timer = setInterval(() => {
    tries++;
    if (running) return;
    running = true;
    boot().then(ok => { running = false; if (ok) clearInterval(timer); })
      .catch(e => { running = false; console.error('[阅卷助手] 启动失败：' + (e && e.message)); if (tries > 8) clearInterval(timer); });
  }, 800);
  boot();
})();
