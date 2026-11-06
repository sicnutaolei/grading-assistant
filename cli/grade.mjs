#!/usr/bin/env node
// 判分链路自检：本地图片 -> DeepSeek(deepseek-flash) -> 逐空得分 + 总分
// 用法：node cli/grade.mjs --image fixtures/answer-226-1-1.png --expect 4
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../extension/rubric-core.js');
require('../extension/rubric-chem-q16.js');
require('../extension/rubric-yw-translate.js');
require('../extension/rubric-q19.js');
const RUBS = require('../extension/rubrics.js');
require('../extension/llm.js');
const R = RUBS.get(arg0('rubric', 'chem-q16'));
if (!R) { console.error('未知细则：' + arg0('rubric') + '，可用：' + RUBS.list().map(function (x) { return x.id; }).join('、')); process.exit(2); }
function arg0(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  if (i > 0) return true;
  return dflt;
}
function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const f = arg('key-file', 'secrets/deepseek.key');
  if (typeof f === 'string' && fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  }
  return '';
}
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const imagePath = arg('image', '');
if (!imagePath || typeof imagePath !== 'string' || !fs.existsSync(imagePath)) {
  console.error('缺少图片：--image <答题卡图片路径>');
  process.exit(2);
}
const key = readKey();
if (!key) {
  console.error('缺少密钥：set DEEPSEEK_API_KEY=sk-xxx 或写入 secrets/deepseek.key');
  process.exit(2);
}
let mediaType = MEDIA[path.extname(imagePath).toLowerCase()] || 'image/png';
let imageBase64 = fs.readFileSync(imagePath).toString('base64');
const rawKb = Math.round(imageBase64.length / 1024);
const verbose = !!arg('verbose', false);

// 与扩展一致：长边压到 maxEdge 的 JPEG
const maxEdge = Number(arg('max-edge', 1600)) || 1600;
try {
  const { default: sharp } = await import('sharp').catch(() => ({ default: null }));
  if (sharp) {
    const buf = await sharp(imagePath).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
    imageBase64 = buf.toString('base64');
    mediaType = 'image/jpeg';
  }
} catch (e) { if (verbose) console.error('[img] 未压缩：' + e.message); }

console.log('细则 ' + R.name + '（' + R.RUBRIC_VERSION + '），满分 ' + R.FULL_SCORE + '，图片 ' + path.basename(imagePath) +
  '（原始 ' + rawKb + 'KB base64 → 发送 ' + Math.round(imageBase64.length / 1024) + 'KB）');

// 参考结构图：内置图从 extension/ 目录读，自定义图支持 data URL
const refs = [];
for (const b of R.BLANKS) {
  if (!b.standardImage) continue;
  try {
    if (b.standardImage.indexOf('data:') === 0) {
      const parts = b.standardImage.split(',');
      refs.push({ label: b.label, base64: parts[1], mediaType: (parts[0].split(';')[0].replace('data:', '')) || 'image/png' });
    } else {
      const file = path.join('extension', b.standardImage);
      refs.push({ label: b.label, base64: fs.readFileSync(file).toString('base64'), mediaType: 'image/png' });
    }
  } catch (e) { console.error('[ref] 跳过 ' + b.standardImage + '：' + e.message); }
}
if (refs.length) console.log('附带参考结构图 ' + refs.length + ' 张：' + refs.map(r => r.label).join('、'));

const client = globalThis.createLlmClient({
  baseUrl: arg('base-url', 'https://api.deepseek.com'),
  getKey: () => key,
  timeoutMs: Number(arg('timeout', 180000)),
  log: verbose ? (...a) => console.error('[net]', ...a) : () => {}
});

fs.mkdirSync('logs', { recursive: true });

function render(v) {
  return v.blanks.map(b => '  ' + b.label + '  ' + b.score + '/' + b.max +
    '  识别: ' + (b.raw || '(空)').replace(/\s+/g, ' ').slice(0, 60) + '\n         依据: ' +
    (b.reason || '').replace(/\s+/g, ' ').slice(0, 90)).join('\n');
}

const expect = typeof arg('expect', null) === 'string' ? Number(arg('expect')) : null;
const repeat = Number(arg('repeat', 1)) || 1;
const results = [];
for (let round = 1; round <= repeat; round++) {
  if (repeat > 1) console.log('—— 第 ' + round + '/' + repeat + ' 次 ——');
  try {
    const res = await client.judge({ rubric: R, references: refs, imageBase64, mediaType, model: arg("model", "deepseek-flash"), maxTokens: Number(arg("max-tokens", 0)) || undefined, thinking: arg("thinking", "off") });
    const parsed = res.parse;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join('logs', stamp + '-r' + round + '.json'), JSON.stringify({ model: res.model, usage: res.usage, elapsedMs: res.elapsedMs, raw: res.rawText }, null, 2));
    if (!parsed.ok) {
      console.log('解析失败（' + parsed.issues.join('；') + '），原始输出见 logs/');
      console.log(String(parsed.raw).slice(0, 500));
      results.push({ total: null, ok: false });
      continue;
    }
    const v = parsed.verdict;
    const u = res.usage || {};
    console.log(res.model + '  第' + res.attempts + '次尝试  用时 ' + (res.elapsedMs / 1000).toFixed(1) + 's  tokens 输入' + (u.prompt_tokens || '?') + '/输出' + (u.completion_tokens || '?') + '  置信度 ' + v.confidence);
    console.log(render(v));
    console.log('  总分：' + v.total + ' / ' + v.fullScore);
    if (parsed.issues.length) console.log('  校正：' + parsed.issues.join('；'));
    results.push({ total: v.total, ok: true, verdict: v });
  } catch (e) {
    console.log('失败：' + e.message);
    if (verbose && e.stack) console.error(e.stack);
    results.push({ total: null, ok: false, error: e.message });
  }
}
if (arg('json', false)) console.log(JSON.stringify(results.map(r => r.verdict || r), null, 2));
if (expect !== null) {
  const bad = results.filter(r => r.total !== expect);
  console.log('期望总分 ' + expect + '：' + (bad.length ? bad.length + ' 次不一致（实际 ' + results.map(r => r.total).join('/') + '）' : '全部一致 ' + results.length + '/' + results.length));
  process.exit(bad.length ? 1 : 0);
}
