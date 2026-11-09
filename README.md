# DocLabeler

本地运行的文档字段标注工具，面向 OCR / 文档抽取项目。一个工作区可以放多个项目，每个项目使用独立的图片目录、schema、标注、合集与导出，互不干扰。

- 后端：Python 3.10+ / FastAPI / Uvicorn
- 前端：原生 HTML + CSS + ES Module，无构建步骤
- 存储：文件（JSON / CSV / PNG），不依赖数据库
- 图片：只读，不做任何修改、移动或删除

## 安装与启动

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows
pip install -r requirements.txt

python app.py --workspace D:\data\doclabeler
```

打开 http://127.0.0.1:8000

可选参数：

```
--host 127.0.0.1     监听地址，默认仅本机
--port 8000          端口
--open               启动后自动打开浏览器
```

## 工作区结构

```
<workspace>/
  projects/
    <project_id>/
      project.json          # name / images_dir / description / created_at
      schema.json           # 当前 schema（含 version）
      schemas/v1.json ...   # 每次保存的 schema 快照，用于历史标注重映射
      cases_index.json      # case_id ↔ 相对路径、尺寸、页数
      annotations/<case_id>.json
      .baseline/<import_id>/   # 导入快照（不可变），含 cases/*.json、meta.json、report.json
      imports/index.json
      imports/reports/<import_id>.json
      collections/          # 旧版手动合集，首次加载时迁移为标签并归档为 *.migrated
      exports/<version>/
      .cache/preview/       # 预览 PNG 缓存
```

`images_dir` 支持绝对路径，也支持相对 workspace 的路径。工具只读取该目录。

## 图片与 case

- 递归扫描 `jpg / jpeg / png / tif / tiff / bmp / webp`，一张图 = 一个 case。
- `case_id` 由相对路径去掉扩展名后生成：非字母数字转下划线，例如
  `2024/10/14/A-001.png` → `2024_10_14_A_001`。
- **case_id 冲突会直接报错**，并列出冲突的源文件。不会自动改名，请调整目录或文件名后重新扫描。
- 多页 TIF 只标注第一页，列表中会显示提示。
- 无法解码的图片会记录在索引的 `unsupported` 中并提示，不会静默消失。
- 预览使用 Pillow 做 EXIF 方向校正后转 PNG，缓存在项目 `.cache/preview/`。

## Schema

字段结构：

```json
{
  "id": "fld_ab12cd34",
  "label": "单据号",
  "type": "string",
  "required": true,
  "enum": [],
  "description": "",
  "validation": [],
  "children": []
}
```

约定：

- `values` 的 object key 使用**字段 label**（界面显示名），数组下标写成 `items[0].amount`。
- 同级字段 label 必须唯一，否则 schema 保存会被拒绝。
- `id` 不可变，用于在 schema 版本之间对齐节点。
- **修改 label 会自动迁移历史标注**：values 的 key、`notes` 的字段路径都会重映射；
  baseline 在比较时会按导入时的 schema 版本重映射到当前版本。
- 每次保存都会写入 `schemas/v<N>.json` 快照，可回溯历史结构。

Schema 来源只有一个入口：在「New project」里贴一份示例 JSON。对象 → object，数组 →
可重复组，字段名和类型都从这份样例推断；留空则从空白 schema 开始，之后都可在
Schema 编辑器里继续调整。

### 跨字段校验规则

在 Schema 编辑器里点字段（或 Root object）的 **Rules**，填一个 JSON 数组。规则只在后端求值，
前端编辑时防抖请求 `POST /api/projects/<id>/validate`，因此表单提示和列表筛选用的是同一套逻辑。
规则**只提示、不阻止保存草稿**。

| type | 作用 | 主要参数 |
|---|---|---|
| `sum` | 明细求和等于目标字段 | `target`、`source`（如 `items[].amount`）、`tolerance`（默认 0.01） |
| `regex` | 值匹配正则 | `pattern` |
| `date` | 严格日期校验 | `format`：`YYYY-MM-DD`（默认）/ `YYYY/MM/DD` / `YYYYMMDD` / `DD/MM/YYYY` / `MM/DD/YYYY`，含时刻的两种变体 |
| `compare` | 与另一字段比较 | `other`、`op`（`== != > >= < <=`） |
| `range` | 数值区间 | `min`、`max` |
| `length` | 字符串长度 | `min`、`max` |
| `checksum` | 校验位 | `algorithm`：`luhn` / `idcard`（18 位身份证） |

挂在 root 上的例子（路径写绝对值，数组用 `[]` 模板）：

```json
[
  {"type": "sum", "target": "total", "source": "items[].amount", "tolerance": 0.01,
   "message": "明细合计与总金额不一致"},
  {"type": "regex", "path": "doc_no", "pattern": "^INV-\\d{6}$", "message": "单据号格式不对"},
  {"type": "date", "path": "issue_date", "format": "YYYY-MM-DD"},
  {"type": "compare", "path": "end_date", "other": "start_date", "op": ">="},
  {"type": "checksum", "path": "card_no", "algorithm": "idcard"}
]
```

挂在某个标量字段上时 `path` 可省略，默认就是该字段；路径里带 `[]` 的规则会对每个数组元素
分别求值，`compare` 的 `other` 同样带 `[]` 时按**同一下标**配对（如
`items[2].end_date` 只与 `items[2].start_date` 比较）。保存 schema 时会校验规则写法
（类型白名单、正则可编译且非空、`range` / `length` 的 `min` / `max` 为有限数值且 `min <= max`、
必填参数），错误直接拒绝保存，避免坏规则静默失效。

## 标注

`annotations/<case_id>.json`：

```json
{
  "case_id": "2024_10_14_A_001",
  "source": "2024/10/14/A-001.png",
  "schema_version": 3,
  "values": { "doc_no": "A-001", "items": [{ "description": "CT Brain" }] },
  "notes": { "doc_no": "编号位于页眉右上角" },
  "evidence": {
    "doc_no": { "bbox": [0.12, 0.08, 0.30, 0.05], "page": 0, "text": "A-001" }
  },
  "status": "draft",
  "tags": ["门诊"],
  "baseline_import_id": "imp_20261109_101500_ab12",
  "rev": 7,
  "updated_at": "2026-11-09T10:15:00+08:00"
}
```

- 自动保存：修改后防抖 1 秒；`Ctrl+S` 立即保存。
- 保存带 `rev` 乐观锁，多窗口同时编辑会返回 409 并重新加载，不会互相覆盖。
- 必填、类型、枚举在前端就地提示，但**不阻止保存草稿**；跨字段规则错误另有一行提示。
- 字段备注按 `field_path` 存储（`items[0].amount` 这种路径）。
- `evidence` 按 `field_path` 存储字段在图片里的位置，`bbox` 是 `[x, y, w, h]` **归一化到 0-1**
  的坐标（相对 EXIF 校正后的整幅图），`page` 为页/帧序号，`text` 是可选的 OCR 文本片段。
  改 label 时证据路径和备注一样会按不可变字段 id 重映射。

## 导入已有标注

支持三种格式：

- JSON：每个 case 一个文件，文件名或内容里的 `case_id` 用于匹配。
- CSV / Excel 长表，列固定为：

```csv
case_id,field_path,value,note,confidence,bbox,text,page
2024_10_14_A_001,doc_no,A-001,,0.98,"0.12,0.08,0.30,0.05",A-001,0
2024_10_14_A_001,total,3040,合计与明细一致,0.74,"0.60,0.71,0.20,0.04",3040,0
2024_10_14_A_001,items[0].description,CT Brain,,
2024_10_14_A_001,items[0].amount,3040,,
```

`confidence` 可选，接受 0-1 或 0-100；低于 0.8 的字段会在表单和列表中标记，
用于优先复核低置信度结果。JSON 导入可在每个 case 里带 `"confidence": {"doc_no": 0.9}`。

也可以直接导入**宽表**（一行一个 case，没有 `field_path` / `value` 列）。表头按 schema
的字段路径匹配，匹配不上时再按字段 label 匹配；数组字段写 JSON 字符串。导出的
`summary.csv` 可以直接回灌，`status` 与 `notes`（JSON 对象）列也会生效：

```csv
case_id,source,status,doc_no,total,issue_date,items,notes
2024_10_14_A_001,A-001.png,done,A-001,3040,2026-11-09,"[{""description"": ""CT Brain"", ""amount"": ""3040""}]","{""total"": ""合计与明细一致""}"
```

宽表只要求有 `case_id` 或 `source` 列；两者都有时优先 `case_id`。

`bbox` / `text` / `page` 可选，用于把模型输出直接带上原文位置：`bbox` 写 `x,y,w,h`
（0-1 归一化，也兼容 0-100 百分比），导入后点字段就能在图上高亮该区域。
JSON 导入可带 `"evidence": {"doc_no": {"bbox": [0.12,0.08,0.30,0.05], "text": "A-001"}}`。
预测框同时写进 `.baseline/<import_id>/` 快照；`baseline` 导入模式只刷新快照、不覆盖人工框选。

导入规则：

- `case_id` 会先做精确匹配；匹配不上时，按图片相对路径和文件名的完整片段做二次匹配。
  例如图片为 `B10112_12312_9182_case/img1.png`（生成的 case_id 是
  `B10112_12312_9182_case_img1`），下列写法都能关联：
  - 完整 case_id：`B10112_12312_9182_case_img1`
  - 带扩展名：`B10112_12312_9182_case_img1.png`
  - 相对路径：`B10112_12312_9182_case/img1.png` 或 `B10112_12312_9182_case/img1`
  - 路径片段：`B10112`、`img1`（片段需完整，`B101` 不会命中 `B10112`）
- 片段匹配命中多张图时（例如 `B10112` 对应目录下 `img1.png`、`img2.png`），按路径排序
  取第一张，并在导入报告里记一条 `ambiguous_case`；需要精确指定时请改用完整 case_id。
- `value` 按 schema 类型转换；数字、布尔、枚举不符会写入报告并跳过该字段，不会写入脏数据。
- 缺失 case、缺失字段、类型不符都记录在 `imports/reports/<import_id>.json`，不静默丢弃。
- 每次导入生成 `.baseline/<import_id>/` 快照，annotation 里记录 `baseline_import_id`。
- 导入模式：`overwrite`（覆盖）、`fill_empty`（只填空字段）或 `baseline`（只更新 baseline）。
- `baseline` 用于 LLM 换 prompt 后重新跑的结果：新预测只写入 baseline，当前值与备注保持
  人工修正后的内容，右侧差异会直接显示「新预测 vs 人工值」。
- `fill_empty` 跳过的字段仍会写入 baseline，因此之后修改该字段时依然能和导入值做差异对比。

## 差异高亮

- 当前值与 baseline 逐字段比较，区分新增 / 修改 / 删除；表单补齐的空值不计为「新增」。
- 修改字段显示原值，并提供单字段「回退」。
- 列表过滤：全部 / 待复核 / 已改 / 未标 / 低置信度 / 有校验错误 / 抽样 / 已完成 / 有备注；
  低置信度按最差分数升序，待复核按复核优先级排序。
- 已知边界：数组按索引比较，`items` 中间插入一项会让后续项都显示为修改。

## 搜索与修正回流

- 搜索除 case_id 与路径外，还覆盖所有字段值和字段备注；命中字段会显示在列表项下方，
  点击可直接跳到该字段。
- `GET /api/projects/<id>/search-index` 返回每个 case 的可搜索文本，前端打开项目后后台加载。
- `GET /api/projects/<id>/corrections.csv` 按字段聚合「baseline(模型) vs 当前(人工)」的修改与
  删除，附出现次数、样例 case 与备注，可直接用于 few-shot 或修改 prompt。界面入口在
  Notes & prompt 弹窗底部。

## 字段 ↔ 原文互定位

OCR + LLM 复核最费时间的是「看着一个金额，回原图找它在哪」。这个功能把两者绑起来：

- **点字段右侧的取景框按钮**：已有证据框时把图片缩放到该区域并高亮；没有时进入框选模式，
  在图上拖一个框即可绑定。`Shift+click` 重新框选，`Alt+click` 删除。
- **框选后可输入该处文字**：回车会同时保存区域并**回填字段值**（`Box only` 只存区域）。
- **反向**：点图片上的框会滚动并聚焦到对应字段；`b` 快捷键或查看器工具栏的取景框按钮可以
  「先选字段再框图」。
- 归一化 bbox 与预览缩放无关，缩放 / 平移 / 旋转后框始终贴合原图。
- 导出时可选生成字段裁剪图（`cases/<case_id>/crops/*.png`）与 `evidence.csv`，可直接喂版面 / 字段识别模型。

已知边界：多页 TIF 目前只标注和预览第一页，`page > 0` 的证据框仍会保存和导出裁剪图，
但预览高亮不会自动翻页。

## 批量确认与抽样复核队列

顶栏的批量确认按钮打开一个两步对话框：先 **Preview**，再 **Confirm eligible cases**。

- 只有同时满足以下条件的 case 才会被自动置为 `done`：已有标注且未完成、最低置信度 ≥ 阈值
  （默认 0.95，**没有置信度信息的一律不自动确认**）、无人工修正差异、必填齐全、无跨字段规则错误。
- 通过筛选的 case 里按 `sha1(project_id:case_id)` 确定性抽样（默认 10%），抽中的保持 `draft`
  并打标签 `review-sample`，进入强制人工队列 —— 预览与执行得到的是同一批。
- 列表新增 `Pending`（按 规则错误 → 低置信度 → 有修正 → 抽样 排序）与 `Sample` 过滤；
  顶栏进度显示 `Done X / Y · Pending Z`。
- `Space` 现在标记当前 case 完成后跳到**下一个待复核**，而不是机械地跳列表下一张。
- 后端接口：`POST /api/projects/<id>/review/preview`、`/review/apply`。

## Prompt 迭代回归对比

顶栏的指标按钮打开 `Prompt regression metrics`，回答「换 prompt 后到底好多少」：

- 以**每次导入的 baseline 预测**对比**当前人工修正值（视为真值）**，逐字段统计
  正确 / 改错 `wrong` / 漏抽 `missing` / 多抽 `extra`，得出整体准确率。
- 按字段准确率排序，优先暴露最差的字段；按置信度分桶（0–50 / 50–80 / 80–95 / 95–100 / 无分数）
  看校准情况，判断「模型说有把握时是否真的对」。
- 任意两个导入版本可做字段级对比，按退化幅度排序；运行列表给出每次导入的时间、模式、case 数、准确率。
- 数字字符串与数字视为等价（去千分位、货币符号）；历史 baseline 会按导入时的 schema 版本重映射。
- 接口：`GET /api/projects/<id>/metrics`、`GET /api/projects/<id>/metrics.csv`（每版本 × 每字段一行）。
- 注意：真值是「当前人工值」，所以所有版本都在和同一份修正结果比较；越早的导入通常准确率越低，
  这正是迭代效果的体现。

真值口径明确写在接口返回里（`truth_definition`、`truth_case_count`、`unannotated_case_count`、
`invalid_file_count`、`skipped_runs`）：

- 只有**同时存在 baseline 预测和人工标注**的 case 才计分；还没人工标的 case 不算「模型漏抽」，
  也不会混进分母。完全没有可比较 case 的导入不会产出准确率为 0 的伪版本，而是列入 `skipped_runs`
  （前端会提示「还没有真值」而不是「还没有导入」）。
- 字段改名后，历史 baseline 的 confidence / evidence 路径 key 也按不可变字段 id 重映射，
  校准分桶不会因找不到分数而全部落进 `No score`。
- 单个写坏的 baseline / 标注 JSON 会被跳过并计数，不会让 case 列表或指标接口 500。

## 导出

导出到 `exports/<YYYYMMDD-HHMMSS>[-标签]/`：

```
manifest.csv
manifest.json
schema.json
fields.csv          # field_path, id, label, type, required, enum, description
summary.csv         # 一行一个 case 的宽表，数组字段为 JSON 字符串，备注单独一列
evidence.csv        # 全部证据框：case_id, field_path, bbox, page, text, crop_file（有证据框时）
cases/<case_id>/image.png
cases/<case_id>/label.json   # 含 evidence
cases/<case_id>/notes.csv
cases/<case_id>/evidence.csv # 有证据框时
cases/<case_id>/crops/*.png  # 字段裁剪图（勾选 "Export field crop images" 时）
```

`manifest.csv` 列：

```
case_id, source, source_abs, exported_image, sha256, exported_sha256, schema_version, exported_at
```

- `source` 相对 `images_dir`，`source_abs` 是原始图片绝对路径，`sha256` 是原图哈希，可完整回溯。
- 导出图片统一做 EXIF 校正并转 PNG，原始图片不改动；字段裁剪图按归一化 bbox 从原图裁出，
  四周各留 2% 余量，`page` 指定页/帧。
- 导出先写 `exports/.staging-*` 隐藏临时目录，全部产物写完才原子重命名成最终版本目录；
  中途失败会清理临时目录，不再留下看似正常的半成品导出。崩溃残留的 staging 目录不会出现在导出列表里。
- 原图缺失 / 无权限 / 字段裁剪失败不再被静默吞掉，也不会让整个导出 500：该 case 仍会导出标注数据，
  manifest 里对应列留空，明细记入 `manifest.json` 的 `warnings`，结果弹窗显示 warning 数量。

## 界面

界面文案为英文，样式基于本地引入的 Bootstrap 5.3.3 与 Bootstrap Icons（见
`static/vendor/`，不依赖 CDN，离线可用）。

- 左：目录分组的图片列表、全局搜索（case / 路径 / 字段值 / 备注）、过滤（含待复核 / 规则错误 / 抽样）、
  标签筛选、多选与批量操作。
- 中：图片查看器，滚轮以鼠标位置缩放、拖拽平移、旋转、适应窗口；叠加字段证据框与框选；
  `←` / `→` 切换 case；`p` 演示当前列表。
- 右：schema 表单、字段备注、差异提示、必填与跨字段规则提示；顶部状态与标签；
  低于 80% 置信度的字段带百分比标记。
- 顶栏：批量确认与抽样队列、回归指标、备注与 prompt、导入 / 导出 / Schema / 重新扫描。
- 底：只读原始 JSON。
- 快捷键：`Space` 标记 Done 并跳到下一个待复核，`b` 选字段再框选，`Ctrl+S` 保存，`?` 查看全部。

## 代码结构

后端按领域拆成 `api/` 包，`app.py` 只负责装配应用与 CLI 启动：

```
app.py                     # create_app(workspace) / 命令行入口
locks.py                   # 项目级 RLock：串行化 schema / 导入 / 迁移 / 批量写入
api/deps.py                # 工作区解析、项目 / schema / 索引校验、旧合集迁移
api/routes_projects.py     # 项目、case 列表（含校验错误计数）、图片预览
api/routes_schema.py       # schema 读写与推断 / 导入、规则写法校验
api/routes_annotations.py  # 标注、批量、差异、回退
api/routes_review.py       # 批量确认与确定性抽样复核队列
api/routes_metrics.py      # 即时规则求值、回归指标与 CSV
api/routes_io.py           # 导入 / 导出
api/notes.py               # 搜索索引、备注聚合、prompt 草稿、corrections.csv
validation.py              # 声明式跨字段规则求值（纯计算，无 HTTP）
metrics.py                 # baseline 与人工值的聚合指标（纯计算，无 HTTP）
```

前端为原生 ES Module，`static/js/main.js` 只按序加载模块并启动路由：

- `state.js`：共享 `state` / `ui` 状态与 `actions` 函数注册表。各模块加载时把自己的
  函数注册进去，跨模块调用统一走 `actions.xxx()`，因此模块之间不循环 import。
- 职责模块：`history.js`（撤销重做）、`projects_view.js`、`shell.js`（骨架与事件绑定）、
  `case_list.js`（过滤与复核队列排序）、`thumbs.js`、`bulk.js`、`panes.js`、`case_view.js`、
  `case_panels.js`、`saving.js`、`evidence.js`（字段 ↔ 原文）、`review.js`（批量确认弹窗）、
  `metrics.js`（回归指标弹窗）、`top_actions.js`、`presentation.js`、`shortcuts.js`。
- 无共享状态的可复用组件：`form.js`、`viewer.js`（含证据框 overlay）、`modal.js`、`modals.js`、
  `notes.js`、`schema_editor.js`。

新增前端功能时：在对应模块写函数，并在该文件末尾的 `Object.assign(actions, {...})`
里注册，其他模块即可调用；新增后端接口时：在对应的 `api/routes_*.py` 里加路由，
共享的项目 / schema / 索引解析统一从 `api/deps.py` 取。

## 测试

```bash
python -m pytest tests -q
```

覆盖：case_id 生成与冲突、case_id 片段匹配与歧义取首张、CSV 长表导入与类型校验、
导出 manifest 完整性、label 改名后的标注迁移、API 主流程与乐观锁、批量操作、
revert all、旧合集迁移为标签、备注聚合与冲突判定、prompt 草稿、baseline-only 导入、
全局搜索索引、置信度标记与 corrections.csv。

`tests/test_optimizations.py` 覆盖项目级并发锁、baseline 请求内缓存、指标真值口径与坏文件容错、
导出原子发布与 warning；`tests/test_frontend_smoke.py` 用系统 Node 无头加载全部 ES modules，
校验刷新失败兜底与规则徽标局部刷新（需本机有 `node`，没有则自动跳过）。

## 可靠性与并发边界

- 所有会改标注 / schema 的写入都经过 `locks.project_lock`（项目级可重入锁），锁序固定为
  「项目锁 → 单条 case 锁」。两个并发 `PUT /schema` 不会都通过版本检查，导入、批量确认、
  旧合集迁移与 schema 迁移互相串行；标注 `rev` 乐观锁不再被迁移路径绕过。
- `/cases` 与复核队列预览在一次请求内只编译一次校验规则、只按导入版本读一次 baseline 元数据，
  几百张 case 时不再逐张重复读同一份 `meta.json` / `schemas/vN.json`。
- `refreshProject` 失败会保留旧数据、给出明确提示与顶栏 `Retry refresh` 入口，不再是
  unhandled rejection；`/validate` 结果只局部更新当前 case 的规则错误徽标与过滤计数
  （仅在 `Rule errors` 过滤下才整表重绘），不打断多选与列表滚动。

## 当前范围

已实现：多项目、扫描、schema 三种来源与版本快照、标注与自动保存、导入与 baseline、
差异高亮与单字段/整体回退、置信度标记与低置信度过滤、baseline-only 重跑导入、
导出（JSON / 宽表 CSV / manifest / corrections.csv / 字段裁剪图）、批量状态与标签、
标签筛选与演示模式、备注聚合（冲突标记）与 prompt 草稿、字段级 undo/redo、
全局搜索（case / 路径 / 字段值 / 备注）。

复核闭环增强：字段证据框（导入 bbox 或人工框选，图上高亮 / 放大 / 反查字段 / 回填值）、
批量确认 + 确定性抽样复核队列、声明式跨字段校验规则（合计 / 正则 / 日期 / 校验位 / 比较等）、
prompt 迭代回归对比（按字段准确率、错误类型、置信度校准、版本 delta）。

界面提供进度与待复核计数、下一张待复核、搜索与过滤计数、缩略图条、分栏拖拽、快捷键帮助、
全局保存状态与冲突处理、`Space` 快速复核并跳到下一个待复核。

旧版「合集」已合并进标签：打开项目时会把 `collections/*.json` 里的每个合集转成同名
标签，原文件归档为 `collections/*.json.migrated`，不再显示。
