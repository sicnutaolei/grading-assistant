// 扩展面板冒烟测试：jsdom 里搭假阅卷页，跑装配 -> 判分 -> 倒计时 -> 提交 -> 翻页复位
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const read = f => fs.readFileSync(new URL('../extension/' + f, import.meta.url), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); fails.push(name); }
}

function makeEnv(overrides = {}, keypadMax = 4, opts = {}) {
  const lis = Array.from({ length: keypadMax + 1 }, (_, n) => `<li class="f-csp">${n}</li>`).join('');
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="header"><span id="code">密号：1713-1-3</span><span id="graded">已评：1</span></div>
    <canvas width="120" height="90"></canvas>
    <div class="bzList"><div class="dfBox"><ul class="scores">${lis}</ul>
      <div class="fs"><p>得分：</p><label id="scored">0</label></div>
      <span class="submit-btn">提交分数</span>
    </div></div>
  </body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = () => ({ width: 120, height: 30, left: 10, top: 10, right: 130, bottom: 40, x: 10, y: 10 });
  const ctx = {
    fillStyle: '', fillRect() {}, drawImage() {},
    getImageData(x, y, ww, hh) {
      if (opts.tainted) { const err = new Error('tainted'); err.name = 'SecurityError'; throw err; }
      const data = new Uint8Array(ww * hh * 4).fill(255);
      data[1000] = 0; data[1001] = 0; data[1002] = 0;
      return { data };
    }
  };
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,QUJDRA==';
  w.navigator.clipboard = { writeText: async () => {} };

  const store = Object.assign({
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
    thinking: 'off', timeoutMs: 120000, maxEdge: 1600,
    rubric: 'yw-translate', autoSubmit: false, countdownSec: 3, minConfidence: 0.6, autoNext: false
  }, overrides);
  const env = { w, store, gradeCalls: [], captureCalls: [], history: [] };
  w.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.type === 'getConfig') return cb({ ok: true, config: store, rubrics: w.RUBS.list() });
        if (msg.type === 'setConfig') { Object.assign(store, msg.patch); return cb({ ok: true }); }
        if (msg.type === 'captureArea') { env.captureCalls.push(msg); return cb({ ok: true, base64: 'U0hPVA==', mediaType: 'image/png', w: 700, h: 598 }); }
        if (msg.type === 'grade') { env.gradeCalls.push(msg); return cb({ ok: true, verdict: env.verdict, issues: [], elapsedMs: 1500, imageKb: 12, usage: { total_tokens: 1500 } }); }
        return cb({ ok: false, error: 'unexpected ' + msg.type });
      }
    },
    storage: { local: { get: async (d) => Object.assign({}, d, store), set: async (o) => { Object.assign(store, o); } } }
  };
  env.q = s => w.document.querySelector(s);
  env.setPage = ({ code, scored }) => {
    if (code !== undefined) w.document.getElementById('code').textContent = '密号：' + code;
    if (scored !== undefined) w.document.getElementById('scored').textContent = String(scored);
  };
  env.verdict = {
    rubricId: 'yw-translate', total: 3, fullScore: 4, confidence: 0.9, unreadable: [],
    blanks: [
      { id: 'p-jian', label: '给分点1「荐」', max: 1, standard: '接连', raw: '一起全都', score: 0, reason: '未译出接连' },
      { id: 'p-order', label: '给分点2 宾语前置', max: 1, standard: '凭什么', raw: '如何', score: 0, reason: '一般疑问' },
      { id: 'p-kun', label: '给分点3「困」', max: 1, standard: '困苦', raw: '困境', score: 1, reason: '译出困' },
      { id: 'p-meaning', label: '给分点4 句意', max: 1, standard: '整句', raw: '通顺', score: 1, reason: '大意正确' }
    ]
  };
  env.clicked = [];
  env.submitted = 0;
  for (const li of w.document.querySelectorAll('ul.scores li')) {
    li.addEventListener('click', () => env.clicked.push(li.textContent.trim()));
  }
  w.document.querySelector('.submit-btn').addEventListener('click', () => { env.submitted++; });
  for (const f of ['platform.js', 'rubric-core.js', 'rubric-chem-q16.js', 'rubric-yw-translate.js', 'rubric-q19.js', 'rubrics.js', 'content.js']) w.eval(read(f));
  return env;
}

const statusOf = e => e.q('.q16-status').textContent;
const runGrade = async e => { e.q('.q16-run').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true })); await sleep(400); };
const clickFill = async e => { e.q('.q16-fill').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true })); await sleep(700); };

// —— 场景 A：默认配置（不自动提交）+ 装配检查 ——
console.log('【A】默认配置：装配与手动提交');
{
  const e = makeEnv();
  await sleep(1600);
  check('面板已注入', !!e.q('.q16-host'));
  check('细则下拉有 3 项（化学16/语文/化学19）', e.q('.q16-rubsel').options.length === 3, String(e.q('.q16-rubsel').options.length));
  check('标题跟随细则', /语文/.test(e.q('.q16-title').textContent), e.q('.q16-title').textContent);
  check('表头随细则变"给分点"', e.q('.q16-col0').textContent === '给分点', e.q('.q16-col0').textContent);
  check('总分上限为 4', e.q('.q16-full').textContent.trim() === '/ 4', e.q('.q16-full').textContent);
  check('卷面下拉非空', e.q('.q16-imgsel').options.length >= 1);
  await runGrade(e);
  check('判分请求已发出', e.gradeCalls.length === 1 && !!e.gradeCalls[0].base64);
  check('结果表渲染 4 行', e.q('.q16-table tbody').children.length === 4, String(e.q('.q16-table tbody').children.length));
  check('总分显示 3', e.q('.q16-score').textContent === '3', e.q('.q16-score').textContent);
  check('默认不自动提交', e.clicked.length === 0, e.clicked.join(','));
  setTimeout(() => e.setPage({ code: '1713-1-4', scored: 0 }), 300);
  await clickFill(e);
  check('手动提交点了分值 3', e.clicked.join(',') === '3', e.clicked.join(','));
  check('提交后状态提示已翻页', /已提交 3 分.*下一份 1713-1-4/.test(statusOf(e)), statusOf(e));
  check('提交后面板复位', e.q('.q16-score').textContent === '—' && e.q('.q16-fill').disabled === true);
  check('判分记录已写入', Array.isArray(e.store.history) && e.store.history.length === 1 && e.store.history[0].total === 3, JSON.stringify(e.store.history));
  check('全程未点击提交分数按钮', e.submitted === 0);
}

// —— 场景 B：判分期间翻页，必须拒绝提交 ——
console.log('【B】防串卷：判分后卷面被翻走');
{
  const e = makeEnv();
  await sleep(1600);
  await runGrade(e);
  e.setPage({ code: '9999-9-9' });
  await clickFill(e);
  check('拒绝提交', e.clicked.length === 0, e.clicked.join(','));
  check('给出串卷报警', /卷面已切换/.test(statusOf(e)), statusOf(e));
}

// —— 场景 C：自动提交 + 立即（倒计时 0 秒） ——
console.log('【C】自动提交：判分后直接点分值');
{
  const e = makeEnv({ autoSubmit: true, countdownSec: 0 });
  await sleep(1600);
  e.w.addEventListener('click', () => {}, true);
  const origGrade = e.gradeCalls;
  setTimeout(() => e.setPage({ code: '1713-1-4' }), 900);
  await runGrade(e);
  await sleep(1200);
  check('判分后自动点击了分值 3', e.clicked.join(',') === '3', e.clicked.join(','));
  check('自动提交未点提交分数按钮', e.submitted === 0);
  check('状态显示已提交', /已提交 3 分/.test(statusOf(e)), statusOf(e));
  void origGrade; void sleep;
}

// —— 场景 D：倒计时期间取消 ——
console.log('【D】倒计时可取消');
{
  const e = makeEnv({ autoSubmit: true, countdownSec: 3 });
  await sleep(1600);
  runGrade(e);
  await sleep(600);
  check('倒计时条已显示', e.q('.q16-count').style.display === 'flex' && /秒后自动提交/.test(e.q('.q16-count-txt').textContent), e.q('.q16-count-txt').textContent);
  e.q('.q16-count-cancel').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true }));
  await sleep(500);
  check('取消后未提交', e.clicked.length === 0, e.clicked.join(','));
  check('状态提示已取消', /已取消自动提交/.test(statusOf(e)), statusOf(e));
}

// —— 场景 E：置信度低于阈值不自动提交 ——
console.log('【E】置信度护栏');
{
  const e = makeEnv({ autoSubmit: true, countdownSec: 0 });
  await sleep(1600);
  e.verdict = Object.assign({}, e.verdict, { confidence: 0.3 });
  await runGrade(e);
  await sleep(500);
  check('低置信度不自动提交', e.clicked.length === 0, e.clicked.join(','));
  check('给出置信度提示', /置信度 0.3 低于阈值/.test(statusOf(e)), statusOf(e));
}

// —— 场景 F：第19题（13分），页面分值按钮只到 4 时必须拒绝提交 ——
console.log('【F】第19题细则 + 分值范围护栏');
{
  const e = makeEnv({ rubric: 'chem-q19' }, 4);
  await sleep(1600);
  check('细则名称为第19题', /第19题/.test(e.q('.q16-title').textContent), e.q('.q16-title').textContent);
  check('总分上限 13', e.q('.q16-full').textContent.trim() === '/ 13', e.q('.q16-full').textContent);
  check('表头为"小问"', e.q('.q16-col0').textContent === '小问', e.q('.q16-col0').textContent);
  e.verdict = {
    rubricId: 'chem-q19', total: 9, fullScore: 13, confidence: 0.9, unreadable: [],
    blanks: [
      { id: 'q19-1', label: '（1）官能团', max: 2, raw: '羟基、醚键', score: 2, reason: '两个都对' },
      { id: 'q19-2', label: '（2）命名', max: 2, raw: '3-溴-1-丙醇', score: 2, reason: '正确' },
      { id: 'q19-3', label: '（3）数值', max: 2, raw: '2', score: 2, reason: '正确' },
      { id: 'q19-4', label: '（4）结构式', max: 2, raw: '略', score: 1, reason: '片段正确' },
      { id: 'q19-5', label: '（5）选项', max: 2, raw: 'B、C', score: 2, reason: '全对' },
      { id: 'q19-6', label: '（6）合成路线', max: 3, raw: '略', score: 0, reason: '未画' }
    ]
  };
  await runGrade(e);
  check('渲染 6 行', e.q('.q16-table tbody').children.length === 6, String(e.q('.q16-table tbody').children.length));
  check('总分显示 9', e.q('.q16-score').textContent === '9', e.q('.q16-score').textContent);
  await clickFill(e);
  check('分值超范围时拒绝提交', e.clicked.length === 0, e.clicked.join(','));
  check('提示超出按钮上限', /超出页面分值按钮上限 4/.test(statusOf(e)), statusOf(e));
}

// —— 场景 G：第19题在 0~13 的页面上能正常提交 ——
console.log('【G】第19题正常提交');
{
  const e = makeEnv({ rubric: 'chem-q19' }, 13);
  await sleep(1600);
  e.verdict = {
    rubricId: 'chem-q19', total: 13, fullScore: 13, confidence: 0.9, unreadable: [],
    blanks: [
      { id: 'q19-1', label: '（1）官能团', max: 2, raw: '羟基、醚键', score: 2, reason: '对' },
      { id: 'q19-2', label: '（2）命名', max: 2, raw: '3-溴-1-丙醇', score: 2, reason: '对' },
      { id: 'q19-3', label: '（3）数值', max: 2, raw: '2', score: 2, reason: '对' },
      { id: 'q19-4', label: '（4）结构式', max: 2, raw: '略', score: 2, reason: '对' },
      { id: 'q19-5', label: '（5）选项', max: 2, raw: 'B、C', score: 2, reason: '对' },
      { id: 'q19-6', label: '（6）合成路线', max: 3, raw: '略', score: 3, reason: '对' }
    ]
  };
  await runGrade(e);
  setTimeout(() => e.setPage({ code: '19-1-2' }), 300);
  await clickFill(e);
  check('提交了 13 分', e.clicked.join(',') === '13', e.clicked.join(','));
  check('未点提交分数按钮', e.submitted === 0);
  check('探测信息已渲染', /分值 0–13/.test(e.q('.q16-probe').textContent), e.q('.q16-probe').textContent);
}

// —— 场景 H：canvas 被跨域污染（学科网形态），必须退回截屏取图 ——
console.log('【H】跨域画布 -> 截屏兜底');
{
  const e = makeEnv({ rubric: 'chem-q19' }, 13, { tainted: true });
  await sleep(1600);
  await runGrade(e);
  check('发出了截屏请求', e.captureCalls.length === 1, String(e.captureCalls.length));
  check('截屏区域有效', e.captureCalls[0] && e.captureCalls[0].rect.width > 100, JSON.stringify(e.captureCalls[0] && e.captureCalls[0].rect));
  check('用截屏结果继续判分', e.gradeCalls.length === 1 && e.gradeCalls[0].base64 === 'U0hPVA==', JSON.stringify(e.gradeCalls[0] || {}).slice(0, 60));
}

// —— 场景 I：独立提交按钮（学科网：填分不落库，需点"提交分数"） ——
console.log('【I】填分 + 单独提交按钮');
{
  const e = makeEnv({ rubric: 'chem-q19', autoSubmit: true, countdownSec: 0 }, 13);
  await sleep(1600);
  e.verdict = {
    rubricId: 'chem-q19', total: 9, fullScore: 13, confidence: 0.9, unreadable: [],
    blanks: [
      { id: 'q19-1', label: '（1）', max: 2, raw: '羟基、醚键', score: 2, reason: '对' },
      { id: 'q19-2', label: '（2）', max: 2, raw: '3-溴-1-丙醇', score: 2, reason: '对' },
      { id: 'q19-3', label: '（3）', max: 2, raw: '2', score: 2, reason: '对' },
      { id: 'q19-4', label: '（4）', max: 2, raw: '略', score: 1, reason: '部分' },
      { id: 'q19-5', label: '（5）', max: 2, raw: 'B、C', score: 2, reason: '对' },
      { id: 'q19-6', label: '（6）', max: 3, raw: '略', score: 0, reason: '空' }
    ]
  };
  // 点分值只把分数写进输入框，不翻页；点提交按钮才让"已批阅量"+1
  // 照学科网的真实结构：分数在一个 .ques-score 里的 input 上
  const box = e.w.document.createElement('p');
  box.className = 'ques-score';
  const inp = e.w.document.createElement('input');
  inp.value = '';
  box.appendChild(inp);
  e.w.document.querySelector('.fs').replaceWith(box);
  e.q('ul.scores li:nth-child(10)').addEventListener('click', () => { inp.value = '9'; });
  e.submitted = 0;
  e.q('.submit-btn').addEventListener('click', () => { e.w.document.getElementById('graded').textContent = '已评：2'; });
  await runGrade(e);
  await sleep(1500);
  check('自动填入了 9 分', inp.value === '9', inp.value);
  check('自动点了提交按钮', e.submitted === 1, String(e.submitted));
  check('提交后状态为已提交', /已提交 9 分/.test(statusOf(e)), statusOf(e));
}

console.log(fails.length ? String.fromCharCode(10) + '失败 ' + fails.length + ' 项：' + fails.join('；') : String.fromCharCode(10) + '冒烟测试全部通过');
process.exit(fails.length ? 1 : 0);
