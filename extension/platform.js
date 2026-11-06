// 平台探测：不写死某一家阅卷系统的 class，靠结构特征找"卷面 / 分值按钮 / 当前得分 / 密号"
(function (root) {
  'use strict';

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
  }
  function text(el) { return el && el.textContent ? el.textContent.replace(/\s+/g, '') : ''; }
  function area(el) { const r = el.getBoundingClientRect(); return r.width * r.height; }
  function all() { return Array.prototype.slice.call(document.querySelectorAll('body *')); }

  // —— 卷面：优先同源 canvas（有墨迹），否则取最大的可见 img ——
  function findCanvasLayers() {
    const list = Array.prototype.slice.call(document.querySelectorAll('canvas')).filter(visible);
    return list.filter(function (c) {
      try {
        const ctx = c.getContext('2d');
        if (!ctx || !c.width || !c.height) return false;
        const d = ctx.getImageData(0, 0, Math.min(c.width, 240), Math.min(c.height, 240)).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 10 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) return true;
        }
      } catch (e) { return true; }   // 跨域污染：读不了像素，但仍是卷面，交给截屏兜底
      return false;
    });
  }
  function findImageCandidates() {
    const out = [];
    Array.prototype.forEach.call(document.querySelectorAll('img, canvas'), function (el) {
      if (!visible(el) || area(el) < 60000) return;
      const src = el.tagName === 'IMG' ? (el.currentSrc || el.src || '') : 'canvas';
      out.push({ el: el, src: src, area: area(el) });
    });
    out.sort(function (a, b) { return b.area - a.area; });
    return out.slice(0, 6);
  }

  // —— 分值按钮：先看常见结构，不行再按"成组的 0~N 数字叶子"扫 ——
  function findKeypad() {
    const known = ['ul.scores li', '.key-numbers span', '.key-numbers li', '.level-item', '.score-item',
      '.drag-select-score span.set-btn', '[class*=score] li', '[class*=fraction] li', '[class*=keypad] li'];
    for (var k = 0; k < known.length; k++) {
      const items = Array.prototype.slice.call(document.querySelectorAll(known[k]))
        .filter(function (el) { return visible(el) && /^[0-9]{1,2}$/.test(text(el)); })
        .map(function (el) { return { el: el, n: Number(text(el)) }; });
      if (items.length >= 3) return { items: items, source: known[k] };
    }
    // 通用扫描：找一组连续数字且数量>=3 的兄弟节点
    const groups = {};
    all().forEach(function (el) {
      if (!visible(el) || el.children.length) return;
      if (!/^[0-9]{1,2}$/.test(text(el))) return;
      const p = el.parentElement;
      if (!p || (el.closest && el.closest('.q16-host'))) return;
      const key = (function (n) { const chain = []; let c = n; for (let i = 0; i < 3 && c; i++) { chain.push(c.tagName + '.' + String(c.className).split(' ')[0]); c = c.parentElement; } return chain.join('>'); })(p);
      (groups[key] = groups[key] || []).push({ el: el, n: Number(text(el)) });
    });
    let best = null;
    Object.keys(groups).forEach(function (key) {
      const g = groups[key];
      const nums = g.map(function (x) { return x.n; });
      const uniq = Array.from(new Set(nums)).sort(function (a, b) { return a - b; });
      const contiguous = uniq.length >= 3 && uniq[uniq.length - 1] - uniq[0] === uniq.length - 1;
      if (contiguous && (!best || uniq.length > best.items.length)) best = { items: g, source: 'scan:' + key };
    });
    return best || { items: [], source: 'none' };
  }

  // —— 当前得分：找文本形如 "得分：6" 的最内层元素 ——
  function findScoreReader() {
    // 有的平台把分数放在输入框里（如学科网 .ques-score 内的 el-input）
    const inputSel = ['.ques-score input', '.mark-score input', 'input[class*=score]', 'input[name*=score]'];
    for (var i = 0; i < inputSel.length; i++) {
      const inp = document.querySelector(inputSel[i]);
      if (inp && visible(inp)) {
        const v = String(inp.value).trim();
        return { el: inp, value: /^\d+$/.test(v) ? Number(v) : null, input: true };
      }
    }
    const hits = all().filter(function (el) {
      return visible(el) && /得分[：:]?\s*\d+/.test(text(el));
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return text(a).length - text(b).length; });
    const el = hits[0];
    const m = text(el).match(/得分[：:]?\s*(\d+)/);
    return { el: el, value: m ? Number(m[1]) : null };
  }

  function findCode(patterns) {
    const body = String((document.body && (document.body.innerText || document.body.textContent)) || '');
    const list = patterns || [/密号[：:]?\s*([0-9A-Za-z][0-9A-Za-z\-]*)/];
    for (var i = 0; i < list.length; i++) {
      const m = body.match(list[i]);
      if (m) return m[1];
    }
    return '';
  }
  function findGraded(patterns) {
    const body = String((document.body && (document.body.innerText || document.body.textContent)) || '');
    const m = body.match(/已评[：:]?\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function findSubmitButton() {
    const hits = all().filter(function (el) {
      if (!visible(el) || el.children.length) return false;
      if (el.closest && el.closest('.q16-host')) return false;
      return /^(提交分数|提交评分|提交|保存分数|保存)$/.test(text(el));
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return area(a) - area(b); });
    return hits[0];
  }

  function findProgress() {
    const body = String((document.body && (document.body.innerText || document.body.textContent)) || '');
    const g = body.match(/已(?:批阅|评)[量数]?[：:]?\s*(\d+)/);
    const r = body.match(/剩余[：:]?\s*(\d+)/);
    return { graded: g ? Number(g[1]) : null, remain: r ? Number(r[1]) : null };
  }

  function detect(opts) {
    const o = opts || {};
    const canvas = findCanvasLayers();
    const imgs = findImageCandidates();
    const keypad = findKeypad();
    const score = findScoreReader();
    const max = keypad.items.length ? Math.max.apply(null, keypad.items.map(function (x) { return x.n; })) : null;
    return {
      canvas: canvas,
      imageCandidates: imgs,
      imageKind: canvas.length ? 'canvas' : (imgs.length ? 'img' : 'none'),
      keypad: keypad.items,
      keypadSource: keypad.source,
      keypadMax: max,
      score: score,
      submitButton: findSubmitButton(),
      progress: findProgress(),
      code: findCode(o.codePatterns),
      graded: findGraded()
    };
  }

  root.PLATFORM = { detect: detect, visible: visible, text: text, findCanvasLayers: findCanvasLayers, findImageCandidates: findImageCandidates, findKeypad: findKeypad, findScoreReader: findScoreReader, findSubmitButton: findSubmitButton, findProgress: findProgress, findCode: findCode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
