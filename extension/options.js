const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const msg = (t) => { $('msg').textContent = t; };

async function load() {
  const res = await send({ type: 'getConfig' });
  if (!res || !res.ok) { msg('读取配置失败：' + (res && res.error)); return; }
  const c = res.config;
  const sel = $('rubric');
  sel.innerHTML = '';
  (res.rubrics || []).forEach(it => {
    const o = document.createElement('option'); o.value = it.id; o.textContent = it.name + '（满分' + it.fullScore + '）';
    if (it.id === c.rubric) o.selected = true;
    sel.appendChild(o);
  });
  $('baseUrl').value = c.baseUrl || '';
  $('model').value = c.model || '';
  $('timeoutMs').value = c.timeoutMs || '';
  $('maxEdge').value = c.maxEdge || '';
  $('thinking').value = c.thinking || 'off';
  $('autoSubmit').value = c.autoSubmit ? 'true' : 'false';
  $('autoNext').value = c.autoNext ? 'true' : 'false';
  $('countdownSec').value = (c.countdownSec === 0 ? 0 : (c.countdownSec || 3));
  $('minConfidence').value = (c.minConfidence === 0 ? 0 : (c.minConfidence || 0.6));
  $('apiKey').placeholder = c.apiKey || 'sk-...';
  msg(c.apiKey ? '密钥：' + c.apiKey : '密钥未设置');
  const h = await chrome.storage.local.get({ history: [] });
  const tb = $('hist').querySelector('tbody');
  tb.innerHTML = '';
  (h.history || []).forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + new Date(row.at).toLocaleString() + '</td><td>' + (row.code || '—') + '</td><td><b>' + row.total + '</b></td>';
    tb.appendChild(tr);
  });
  if (!(h.history || []).length) tb.innerHTML = '<tr><td colspan="3">暂无记录</td></tr>';
  const rb = $('rubricText');
  const active = window.RUBS.get($('rubric').value || c.rubric);
  rb.innerHTML = active ? active.BLANKS.map(b =>
    '<p><b>' + b.label + '（满分' + b.max + '）标准答案：' + b.answer + '</b><br>' +
    b.rules.map(r => '· ' + r).join('<br>') + '</p>').join('') : '细则未加载';
}

$('save').addEventListener('click', async () => {
  const patch = {
    baseUrl: $('baseUrl').value.trim() || 'https://api.deepseek.com',
    model: $('model').value.trim() || 'deepseek-flash',
    timeoutMs: Number($('timeoutMs').value) || 120000,
    maxEdge: Number($('maxEdge').value) || 1600,
    thinking: $('thinking').value || 'off',
    rubric: $('rubric').value,
    autoSubmit: $('autoSubmit').value === 'true',
    autoNext: $('autoNext').value === 'true',
    countdownSec: Number($('countdownSec').value),
    minConfidence: Number($('minConfidence').value)
  };
  const key = $('apiKey').value.trim();
  if (key) patch.apiKey = key;
  const res = await send({ type: 'setConfig', patch });
  msg(res && res.ok ? '已保存' : '保存失败：' + (res && res.error));
  $('apiKey').value = '';
  load();
});

$('test').addEventListener('click', async () => {
  msg('正在测试连接…');
  const res = await send({ type: 'testConnection' });
  msg(res && res.ok ? '连接正常（' + res.model + '）：' + res.reply : '连接失败：' + (res && res.error));
});

$('rubric').addEventListener('change', () => {
  const r = window.RUBS.get($('rubric').value);
  $('rubricText').innerHTML = r ? r.BLANKS.map(b => '<p><b>' + b.label + '（满分' + b.max + '）标准：' + b.answer + '</b><br>' + b.rules.map(x => '· ' + x).join('<br>') + '</p>').join('') : '';
});
$('clearKey').addEventListener('click', async () => { await send({ type: 'clearKey' }); msg('密钥已清除'); load(); });
load();

// —— 自定义细则（JSON 编辑） ——
function rubricError(defs) {
  if (!Array.isArray(defs)) return '顶层必须是数组';
  const seen = new Set();
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const where = '第 ' + (i + 1) + ' 项';
    if (!d || typeof d !== 'object') return where + '不是对象';
    if (!d.id || !/^[a-zA-Z0-9_-]+$/.test(d.id)) return where + ' 缺少合法 id（只能用字母数字-_）';
    if (seen.has(d.id)) return 'id 重复：' + d.id;
    seen.add(d.id);
    if (!d.name) return where + ' 缺少 name';
    if (!d.titleLine) return where + ' 缺少 titleLine';
    if (!Array.isArray(d.blanks) || !d.blanks.length) return where + ' 缺少 blanks 数组';
    for (let j = 0; j < d.blanks.length; j++) {
      const b = d.blanks[j];
      const w2 = where + ' 的第 ' + (j + 1) + ' 个给分点';
      if (!b || !b.id) return w2 + '缺少 id';
      if (!b.label) return w2 + '缺少 label';
      if (!(Number(b.max) > 0)) return w2 + '的 max 必须是正数';
      if (!b.answer) return w2 + '缺少 answer';
      if (b.rules && !Array.isArray(b.rules)) return w2 + '的 rules 必须是数组';
    }
  }
  return '';
}

async function loadRubricEditor() {
  const st = await chrome.storage.local.get({ customRubrics: [], rubricImages: [] });
  $('customRubrics').value = JSON.stringify(st.customRubrics || [], null, 2);
  renderRefTable(st.rubricImages || []);
}

function renderRefTable(list) {
  const tb = $('refTable').querySelector('tbody');
  tb.innerHTML = '';
  if (!list.length) { tb.innerHTML = '<tr><td colspan="4">还没有上传参考图</td></tr>'; return; }
  list.forEach((it, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + it.key + '</code></td><td>' + (it.name || '') +
      '</td><td>' + Math.round((it.dataUrl || '').length / 1024) + ' KB</td><td></td>';
    const btn = document.createElement('button');
    btn.className = 'ghost'; btn.textContent = '删除'; btn.style.marginTop = '0';
    btn.onclick = async () => {
      const st = await chrome.storage.local.get({ rubricImages: [] });
      await chrome.storage.local.set({ rubricImages: (st.rubricImages || []).filter((_, k) => k !== i) });
      loadRubricEditor();
    };
    tr.lastChild.appendChild(btn);
    tb.appendChild(tr);
  });
}

$('saveRubrics').addEventListener('click', async () => {
  let defs;
  try { defs = JSON.parse($('customRubrics').value || '[]'); }
  catch (e) { $('rubricMsg').textContent = 'JSON 解析失败：' + e.message; return; }
  const err = rubricError(defs);
  if (err) { $('rubricMsg').textContent = '校验未通过：' + err; return; }
  await chrome.storage.local.set({ customRubrics: defs });
  $('rubricMsg').textContent = '已保存 ' + defs.length + ' 套自定义细则，刷新阅卷页后生效';
  load();
});

$('sampleRubric').addEventListener('click', () => {
  $('customRubrics').value = JSON.stringify([{
    id: 'chem-q20',
    name: '化学 · 第20题（示例）',
    subject: '高中化学',
    itemLabel: '小问',
    titleLine: '20.（12分）',
    blanks: [
      { id: 'a', label: '（1）', max: 2, answer: '标准答案文字', rules: ['答出××得2分', '只写××得1分'], pitfalls: ['写成××不给分'] },
      { id: 'b', label: '（2）结构式', max: 2, type: 'structure', standardImage: 'my-ref-1', answer: '结构描述', rules: ['骨架正确得2分'] }
    ]
  }], null, 2);
}, false);

$('refImage').addEventListener('change', async (e) => {
  const files = Array.prototype.slice.call(e.target.files || []);
  if (!files.length) return;
  const st = await chrome.storage.local.get({ rubricImages: [] });
  const list = st.rubricImages || [];
  for (const f of files) {
    const dataUrl = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsDataURL(f);
    });
    list.push({ key: 'img-' + Date.now() + '-' + Math.round(Math.random() * 1e4), name: f.name, dataUrl: dataUrl });
  }
  await chrome.storage.local.set({ rubricImages: list });
  e.target.value = '';
  loadRubricEditor();
});

loadRubricEditor();
