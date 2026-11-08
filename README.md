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
      collections/          # 预留：手动合集
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

三种来源：

1. 空白 schema，手工在「Schema 编辑」里搭字段树（支持嵌套对象与对象数组）。
2. 从示例 JSON 推断：对象 → object，数组 → 可重复组。
3. 导入 JSON Schema：支持 `type / properties / items / required / enum / description`，不支持 `$ref`。

## 标注

`annotations/<case_id>.json`：

```json
{
  "case_id": "2024_10_14_A_001",
  "source": "2024/10/14/A-001.png",
  "schema_version": 3,
  "values": { "doc_no": "A-001", "items": [{ "description": "CT Brain" }] },
  "notes": { "doc_no": "编号位于页眉右上角" },
  "status": "draft",
  "tags": ["门诊"],
  "baseline_import_id": "imp_20261109_101500_ab12",
  "rev": 7,
  "updated_at": "2026-11-09T10:15:00+08:00"
}
```

- 自动保存：修改后防抖 1 秒；`Ctrl+S` 立即保存。
- 保存带 `rev` 乐观锁，多窗口同时编辑会返回 409 并重新加载，不会互相覆盖。
- 必填、类型、枚举在前端就地提示，但**不阻止保存草稿**。
- 字段备注按 `field_path` 存储（`items[0].amount` 这种路径）。

## 导入已有标注

支持三种格式：

- JSON：每个 case 一个文件，文件名或内容里的 `case_id` 用于匹配。
- CSV / Excel 长表，列固定为：

```csv
case_id,field_path,value,note
2024_10_14_A_001,doc_no,A-001,
2024_10_14_A_001,total,3040,合计与明细一致
2024_10_14_A_001,items[0].description,CT Brain,
2024_10_14_A_001,items[0].amount,3040,
```

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
- 导入模式：`overwrite`（覆盖）或 `fill_empty`（只填空字段）。
- `fill_empty` 跳过的字段仍会写入 baseline，因此之后修改该字段时依然能和导入值做差异对比。

## 差异高亮

- 当前值与 baseline 逐字段比较，区分新增 / 修改 / 删除；表单补齐的空值不计为「新增」。
- 修改字段显示原值，并提供单字段「回退」。
- 列表过滤：全部 / 已改 / 未标 / 已完成 / 有备注。
- 已知边界：数组按索引比较，`items` 中间插入一项会让后续项都显示为修改。

## 导出

导出到 `exports/<YYYYMMDD-HHMMSS>[-标签]/`：

```
manifest.csv
manifest.json
schema.json
fields.csv          # field_path, id, label, type, required, enum, description
summary.csv         # 一行一个 case 的宽表，数组字段为 JSON 字符串，备注单独一列
cases/<case_id>/image.png
cases/<case_id>/label.json
cases/<case_id>/notes.csv
```

`manifest.csv` 列：

```
case_id, source, source_abs, exported_image, sha256, exported_sha256, schema_version, exported_at
```

- `source` 相对 `images_dir`，`source_abs` 是原始图片绝对路径，`sha256` 是原图哈希，可完整回溯。
- 导出图片统一做 EXIF 校正并转 PNG，原始图片不改动。

## 界面

界面文案为英文，样式基于本地引入的 Bootstrap 5.3.3 与 Bootstrap Icons（见
`static/vendor/`，不依赖 CDN，离线可用）。

- 左：目录分组的图片列表、过滤、多选。
- 中：图片查看器，滚轮缩放、拖拽平移、旋转、适应窗口；`←` / `→` 切换 case。
- 右：schema 表单、字段备注、差异提示；顶部状态与标签。
- 底：只读原始 JSON。

## 测试

```bash
python -m pytest tests -q
```

覆盖：case_id 生成与冲突、case_id 片段匹配与歧义取首张、CSV 长表导入与类型校验、
导出 manifest 完整性、label 改名后的标注迁移、API 主流程与乐观锁。

## 当前范围

已实现：多项目、扫描、schema 三种来源与版本快照、标注与自动保存、导入与 baseline、
差异高亮与单字段回退、导出（JSON / 宽表 CSV / manifest）。

尚未实现（数据结构与目录已预留）：手动合集与展示模式、备注聚合与 prompt 草稿、
字段级 undo/redo。
