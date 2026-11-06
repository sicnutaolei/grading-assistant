// 细则注册表：按配置选用哪一套细则（科目/题目）
(function (root) {
  'use strict';
  const DEFAULT_ID = 'chem-q16';
  function setCustom(list) {
    const all = root.RUBRICS || {};
    Object.keys(all).forEach(function (k) { if (all[k] && all[k].__custom) delete all[k]; });
    (list || []).forEach(function (d) {
      try {
        const r = root.createRubric(d);
        r.__custom = true;
        all[d.id] = r;
      } catch (e) { console.warn('[阅卷助手] 自定义细则无效：' + d.id + ' ' + e.message); }
    });
  }

  function get(id) {
    const all = root.RUBRICS || {};
    if (!id) return all[DEFAULT_ID] || null;
    return all[id] || null;   // 严格匹配：找不到就返回 null，绝不静默换成别的题
  }
  function list() {
    const all = root.RUBRICS || {};
    return Object.keys(all).map(function (k) { return { id: k, name: all[k].name, fullScore: all[k].FULL_SCORE }; });
  }
  root.RUBS = { DEFAULT_ID: DEFAULT_ID, get: get, list: list, setCustom: setCustom };
  root.Q16 = get(DEFAULT_ID); // 兼容旧引用：默认细则
  if (typeof module !== 'undefined' && module.exports) module.exports = { get: get, list: list, DEFAULT_ID: DEFAULT_ID };
})(typeof globalThis !== 'undefined' ? globalThis : this);
