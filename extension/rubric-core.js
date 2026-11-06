// 细则引擎：把一套细则定义变成统一的判分接口（识别提示词 + 结果解析校验）
(function (root) {
  'use strict';

  function createRubric(def) {
    const BLANKS = def.blanks;
    const FULL_SCORE = BLANKS.reduce(function (s, b) { return s + b.max; }, 0);

    const SYSTEM_PROMPT = [
      '你是一名' + def.subject + '阅卷助手，负责按给定评分细则为扫描答题卡判分。',
      '你会看到一张答题卡图片（' + def.titleLine + ' 的作答区域）和该题的评分细则。',
      '要求：',
      '1. 先逐条识别学生的原始手写内容（识别不出写 <unreadable>），再严格按细则给分。',
      '2. 只按细则给分，不做额外加分，也不因书写潦草而猜测性给分。',
      '3. 学生涂改时以最终保留的答案为准，被划掉的内容不算。',
      '4. 判分只看卷面实际写了什么，不要因为标准答案长这样就往学生答案上套。',
      '5. 只输出一个 JSON 对象，不要输出 Markdown 代码块或解释性文字。',
      '6. 总分必须等于各条得分之和，且不超过 ' + FULL_SCORE + ' 分。'
    ].join('\n');

    function buildUserPrompt() {
      const lines = [def.titleLine + '（满分' + FULL_SCORE + '分）', def.intro || '', '【评分细则】'];
      BLANKS.forEach(function (b) {
        const tag = b.type === 'structure' ? '［结构式］' : '';
        lines.push(b.label + ' 满分' + b.max + '分；' + tag + '标准：' + b.answer);
        if (b.type === 'structure') {
          lines.push('  - 本题按结构判定：先在 raw 里描述学生实际画出的结构（母核、取代基及其位置、连接方式），再逐项与标准结构比对。');
          lines.push('  - 忽略手绘的比例、角度、字号、是否工整；只看骨架是否正确、取代基种类与位置是否正确、连接是否接错原子。');
          lines.push('  - 取代基位置错、少一个基团、多一个基团、接错原子，该条判 0 分；不要因为"看起来像"就给分。');
        }
        (b.rules || []).forEach(function (r) { lines.push('  - ' + r); });
        (b.pitfalls || []).forEach(function (p) { lines.push('  ! ' + p); });
      });
      if (BLANKS.some(function (b) { return b.standardImage; })) {
        lines.push('【参考结构图】部分给分点附有标准结构图片，按标注顺序出现在这条消息里，请以图片为准与学生的图逐处比对。');
      }
      lines.push('【输出格式】严格输出如下结构的 JSON：');
      lines.push('{"blanks":[{"id":"x","raw":"学生手写原文","score":1,"reason":"一句话判分依据"}],"unreadable":[],"total":0,"confidence":0.9}');
      lines.push('blanks 必须按顺序包含全部 ' + BLANKS.length + ' 条，id 依次取：' + BLANKS.map(function (b) { return b.id; }).join(', ') + '。');
      lines.push('score 为不超过该条满分的整数；raw 只抄学生卷面原文，没写就留空；reason 控制在40字以内；confidence 为 0~1。');
      return lines.filter(function (x) { return x !== ''; }).join('\n');
    }

    function blankById(id) {
      for (let i = 0; i < BLANKS.length; i++) if (BLANKS[i].id === id) return BLANKS[i];
      return null;
    }

    return {
      id: def.id,
      name: def.name,
      subject: def.subject,
      titleLine: def.titleLine,
      itemLabel: def.itemLabel || '空',
      RUBRIC_VERSION: def.id + '@' + (def.version || '1'),
      FULL_SCORE: FULL_SCORE,
      BLANKS: BLANKS,
      SYSTEM_PROMPT: SYSTEM_PROMPT,
      buildUserPrompt: buildUserPrompt,
      blankById: blankById,
      itemLabel: def.itemLabel || '空',
    def: def,
    parseVerdict: function (text) { return parseVerdict(def, text); },
      extractJson: extractJson
    };
  }

  function extractJson(text) {
    if (!text) return null;
    let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === String.fromCharCode(92)) esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    const body = s.slice(start, end + 1);
    const attempts = [body, body.replace(/,\s*([}\]])/g, '$1')];
    for (let i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i]); } catch (e) { /* 试下一个 */ }
    }
    return null;
  }

  // 总分以各条求和为准；缺任何一条即判为失败，绝不把缺失的按 0 分悄悄算进总分
  function parseVerdict(def, text) {
    const BLANKS = def.blanks;
    const FULL = BLANKS.reduce(function (s, b) { return s + b.max; }, 0);
    const issues = [];
    const obj = extractJson(text);
    if (!obj || !Array.isArray(obj.blanks)) {
      return { ok: false, issues: ['模型未返回可解析的 JSON'], raw: text, verdict: null };
    }
    const byId = {};
    obj.blanks.forEach(function (b) {
      if (!b || typeof b.id !== 'string') { issues.push('存在缺少 id 的条目'); return; }
      if (byId[b.id]) issues.push('重复的条目：' + b.id);
      byId[b.id] = b;
    });
    const missing = BLANKS.filter(function (d) { return !byId[d.id]; });
    if (missing.length) {
      return {
        ok: false,
        issues: ['输出缺少 ' + missing.length + ' 条：' + missing.map(function (b) { return b.label; }).join('、') + '（可能被截断）'],
        raw: text, verdict: null
      };
    }
    const blanks = BLANKS.map(function (d) {
      const got = byId[d.id];
      let score = Number(got.score);
      if (!isFinite(score)) { score = 0; issues.push(d.label + ' 缺少分数，按 0 分处理'); }
      if (score < 0) { score = 0; issues.push(d.label + ' 分数越下界，已夹取为 0'); }
      if (score > d.max) { score = d.max; issues.push(d.label + ' 超过该条满分，已夹取为 ' + d.max); }
      return {
        id: d.id, label: d.label, max: d.max, standard: d.answer,
        raw: String(got.raw == null ? '' : got.raw).slice(0, 200),
        score: score,
        reason: String(got.reason == null ? '' : got.reason).slice(0, 200)
      };
    });
    const total = blanks.reduce(function (s, b) { return s + b.score; }, 0);
    if (typeof obj.total === 'number' && obj.total !== total) {
      issues.push('模型总分(' + obj.total + ')与各条之和(' + total + ')不一致，已采用后者');
    }
    let confidence = Number(obj.confidence);
    if (!isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    return {
      ok: true, issues: issues, raw: text,
      verdict: {
        rubricId: def.id, rubricVersion: def.id + '@' + (def.version || '1'),
        blanks: blanks, total: total, fullScore: FULL,
        unreadable: Array.isArray(obj.unreadable) ? obj.unreadable : [],
        confidence: confidence
      }
    };
  }

  root.createRubric = createRubric;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createRubric: createRubric };
})(typeof globalThis !== 'undefined' ? globalThis : this);
