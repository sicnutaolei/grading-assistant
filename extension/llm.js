// OpenAI 兼容视觉接口客户端（默认 DeepSeek：https://api.deepseek.com/chat/completions）
(function (root) {
  'use strict';

  function createLlmClient(options) {
    const baseUrl = String(options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    const getKey = options.getKey;
    const fetchImpl = options.fetchImpl || root.fetch;
    const log = options.log || function () {};
    const timeoutMs = options.timeoutMs || 120000;

    async function post(path, body) {
      const key = getKey();
      if (!key) throw new Error('还没有填写 API Key：点扩展图标 → 设置，粘贴 sk- 开头的密钥。');
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      let res;
      try {
        res = await fetchImpl(baseUrl + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (e) {
        throw new Error('网络请求失败：' + (e && e.name === 'AbortError' ? '超时' : String((e && e.message) || e)));
      } finally { clearTimeout(timer); }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { _raw: text.slice(0, 400) }; }
      if (!res.ok) {
        const m = data && data.error && data.error.message;
        let message = '接口 ' + res.status + (m ? '：' + m : (data && data._raw ? '：' + data._raw : ''));
        if (res.status === 401 || res.status === 403) message = '密钥无效或没有权限（HTTP ' + res.status + '）';
        if (res.status === 429) message = '触发限流（HTTP 429），稍等几秒再试';
        const err = new Error(message);
        err.status = res.status;
        throw err;
      }
      log('ok', res.status, path);
      return data;
    }

    function flatten(content) {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map(function (p) { return p && p.text ? p.text : ' '; }).join(' ');
    }

    // 一张答题卡 -> 一次判分对话；输出被截断或解析不出 7 个空时自动加大预算重试
    async function judge(input) {
      const Q16 = input.rubric || root.Q16;
      if (!Q16) throw new Error('加载顺序错误：必须先加载 rubric-core.js 与各套细则');
      const dataUrl = 'data:' + (input.mediaType || 'image/png') + ';base64,' + input.imageBase64;
      const refs = Array.isArray(input.references) ? input.references : [];
      const body = {
        model: input.model || 'deepseek-flash',
        temperature: input.temperature === undefined ? 0 : input.temperature,
        max_tokens: Number(input.maxTokens) > 0 ? Number(input.maxTokens) : (input.thinking === 'off' ? 2000 : 4000),
        thinking: input.thinking === 'off' ? { type: 'disabled' } : { type: 'enabled' },
        messages: [
          { role: 'system', content: Q16.SYSTEM_PROMPT },
          { role: 'user', content: [{ type: 'text', text: Q16.buildUserPrompt() }]
            .concat([{ type: 'text', text: '【学生答卷】' }, { type: 'image_url', image_url: { url: dataUrl } }])
            .concat(refs.reduce(function (acc, r) {
              acc.push({ type: 'text', text: '【' + r.label + ' 标准结构】' });
              acc.push({ type: 'image_url', image_url: { url: 'data:' + (r.mediaType || 'image/png') + ';base64,' + r.base64 } });
              return acc;
            }, [])) }
        ]
      };
      const started = Date.now();
      const attempts = Math.max(1, Math.min(4, Number(input.retries) || 2));
      let last = null;
      for (let i = 0; i < attempts; i++) {
        if (i > 0) body.max_tokens = Math.min(8000, body.max_tokens + 2000);
        const res = await post('/chat/completions', body);
        const choice = res && res.choices && res.choices[0];
        const content = choice && choice.message ? flatten(choice.message.content) : '';
        last = {
          rawText: content,
          parse: content ? Q16.parseVerdict(content) : { ok: false, issues: ['接口没有返回内容'], raw: '', verdict: null },
          elapsedMs: Date.now() - started,
          usage: res.usage || null,
          model: res.model || body.model,
          attempts: i + 1,
          truncated: !!(choice && choice.finish_reason === 'length')
        };
        if (last.parse.ok) return last;
        log('retry', i + 1, last.truncated ? '输出被截断' : last.parse.issues.join('；'));
      }
      last.parse.issues.push(last.truncated ? '多次尝试后输出仍被截断' : '多次尝试后仍无法解析，请人工判分');
      return last;
    }

    async function ping(model) {
      const res = await post('/chat/completions', {
        model: model || 'deepseek-flash', max_tokens: 16,
        messages: [{ role: 'user', content: '只回复两个字：正常' }]
      });
      const c = res && res.choices && res.choices[0];
      return { reply: c && c.message ? flatten(c.message.content).slice(0, 40) : '', model: res.model };
    }

    return { judge: judge, ping: ping, post: post, baseUrl: baseUrl };
  }

  root.createLlmClient = createLlmClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createLlmClient: createLlmClient };
})(typeof globalThis !== 'undefined' ? globalThis : this);
