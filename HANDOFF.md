# 交接说明（给接手的 agent）

一个 Chrome MV3 扩展：在网页阅卷系统里加一个面板，识别答题卡 → 按内置细则判分 → 填分/提交。
后端是 DeepSeek `deepseek-flash`（原生多模态，OpenAI 兼容）。

## 目录

```
extension/            扩展本体（加载已解压的扩展程序指向这里）
  platform.js         平台自适应探测：卷面 / 分值按钮 / 得分 / 密号 / 提交按钮
  rubric-core.js      细则引擎：生成提示词 + 解析校验判分结果
  rubric-chem-q16.js  化学第16题 14 分 / 7 空
  rubric-yw-translate.js 语文文言文翻译 4 分 / 4 给分点
  rubric-q19.js       化学第19题 13 分 / 6 小问（第4、6小问按结构式判分）
  rubrics.js          细则注册表（含运行时自定义）
  llm.js              OpenAI 兼容视觉客户端（含截断重试）
  background.js       取图、压图、调接口、截屏兜底
  content.js          面板、判分、提交链路
cli/grade.mjs         命令行自检（不经过浏览器）
tests/smoke.mjs       jsdom 面板冒烟测试（41 项断言）
fixtures/             测试图片（含真实学生答卷扫描，见文末）
```

## 已验证

- 化学16题样例卷判 **4/14**，连跑 4 次一致，与人工读卷逐空相同。
- 语文翻译：真实手写样本 3/4 与人工一致；合成样本（全对/错译"荐"/"为什么"/"疲倦"/大面积漏译）全部符合预期。
- 第19题：请求正确附带 2 张参考结构图，模型按 6 条返回，1.3 秒 / 2489 输入 token（**只是链路验证，判分准确率未验证**）。
- 面板逻辑：jsdom 41 项断言全过，含"跨域画布必须走截屏兜底""填分后不翻页必须点独立提交按钮""分值超范围拒绝提交""防串卷"。

## 未验证 / 当前卡点

1. **真实浏览器里从未跑通过一次完整判分**。扩展在用户 Chrome 里的加载状态没确认，CDP 也打不开 `chrome://extensions`。下一步就是让用户在阅卷页 F5 后确认面板出现。
2. 学科网 e卷通（`yuejuan.xkw.com`）的真实判分未跑过。
3. 结构式判分（第19题 (4)(6)）的准确率未验证，缺一份真实学生手绘答卷。

## 六个必须知道的坑

1. **光大阅卷点分值即提交**，没有二次确认，提交后自动跳下一份。所以"填分"是不可逆动作，点击前必须校验卷面身份（密号 + 已批阅量）。
2. **学科网的分值按钮只填不落库**，要再点"提交分数"。两家的行为不同，代码里用"点完看身份是否变化"来区分（`advanced` / `filled`）。
3. **学科网 canvas 被跨域污染**，`getImageData` 抛 SecurityError，只能截屏裁剪。`background.js` 的 `captureArea` 负责这件事。
4. **模型会把输出预算烧在思维链上导致 JSON 截断**。默认已关思维链（`thinking:{type:'disabled'}`，1.7s vs 4.5s）；`parseVerdict` 在"7 个空没全返回"时判失败，绝不把缺失的空按 0 分算进总分。
5. **`RUBS.get()` 严格匹配**，找不到返回 null，不再静默回退到别的题——否则会拿 A 题细则判 B 题。
6. **面板构建必须先接线再 appendChild**，否则中途抛异常会留下"细则下拉空、标题不动"的半瘫面板（已经踩过两次）。

## 怎么跑

```bat
cd grading-assistant
node tests/smoke.mjs                                  :: 41 项面板断言
node cli/grade.mjs --rubric yw-translate --image fixtures/yw/t1-quandui.png --expect 4
node cli/grade.mjs --rubric yw-translate --image fixtures/yw/t2-jian-cuo.png --expect 3
node cli/grade.mjs --rubric chem-q19 --image fixtures/yw/t1-quandui.png
```

注意：化学 4/14 与语文真实手写 3/4 这两组基线用的是真实学生答卷扫描件，
已从仓库移除（只留在原作者本地）。公开仓库里能跑的只有 fixtures/yw/t*.png 合成样本；
要复现化学基线需自备答题卡图片。

密钥：`secrets/deepseek.key`（**不在仓库里**，`secrets/` 已忽略），或 `set DEEPSEEK_API_KEY=sk-xxx`。
`node_modules` 只装了一个 jsdom（测试用），`npm i` 即可。

## 两家平台的选择器对照

| 目标 | 光大 `/njs_3335/#/painter` | 学科网 `yuejuan.xkw.com` |
| --- | --- | --- |
| 卷面 | 4 层同源 canvas，可合成导出 | 2 层 canvas，跨域污染 → 截屏裁剪 |
| 分值按钮 | `ul.scores li` 0–14 | `.key-numbers span.set-btn` 0–13 |
| 当前得分 | `div.fs` 内文本 `得分：N` | `.ques-score input` 的值 |
| 提交 | 点分值即提交，无按钮 | `.read-submit-scores .set-btn` |
| 身份标识 | `密号：xxx` | 无密号，用"已批阅量" |

## 待办（按优先级）

1. 让用户在阅卷页确认面板出现，读面板第二行的探测结果（`平台：…｜分值 …｜得分 …｜密号 …`）。
2. 跑一份真实答卷，核对逐条判分；把（4）（6）手绘结构作为重点。
3. 若某家平台按钮被安全规则拦截或点错，改 `platform.js` 的候选选择器，不要动 `content.js` 的提交链路。
4. 设置页的 JSON 细则编辑器只做了结构校验，没做可视化编辑；`standardImage` 上传后要手填 key。
5. 判分记录（`chrome.storage.local.history`）只在设置页展示，没有导出 CSV。

## 隐私

真实学生答卷扫描件（answer-226-1-1.png、live-300-1-1.png、yw/real-*.png）已从仓库与历史中移除，并写入 .gitignore。
仓库现在只含合成样本 fixtures/yw/t1~t5.png 与标准答案结构图 extension/assets/q19-p*.png。
