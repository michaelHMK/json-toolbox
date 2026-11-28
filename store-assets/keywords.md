# Chrome Web Store 关键词与本地化清单 / Keyword & Localization Matrix

> 本文件仅用于商店运营与关键词追踪，不会打进发布包（`scripts/build_release.py` 仅打包 `src/` 下白名单文件）。
> 所有标题与简介均严格遵守 Chrome Web Store 政策：不堆砌关键词、不夸大未上线功能，名称不超过 4 个核心功能词，名称 ≤ 75 字符，简介 ≤ 132 字符。

## 20 个语言版本的关键词映射

| Locale | 核对状态 | 核心搜索词（3–5 个） | 放置位置 |
| --- | --- | --- | --- |
| `en` | 已人工核对 | `JSON formatter`, `JSON viewer`, `JSON diff`, `JSON to YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `zh_CN` | 已人工核对 | `JSON 格式化`, `JSON 查看`, `JSON 对比`, `YAML 转换`, `JSONC` | `extName` + `extDescription` + 详细描述首段 |
| `zh_TW` | 已人工核对 | `JSON 格式化`, `JSON 檢視`, `JSON 比對`, `YAML 轉換`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `zh_HK` | 已人工核对 | `JSON 格式化`, `JSON 檢視`, `JSON 比較`, `YAML 轉換`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `ja` | 待母语者复核 | `JSON 整形`, `JSON ビューア`, `JSON 比較`, `YAML 変換`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `ko` | 待母语者复核 | `JSON 포맷터`, `JSON 뷰어`, `JSON 비교`, `YAML 변환`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `de` | 待母语者复核 | `JSON formatieren`, `JSON Viewer`, `JSON Diff`, `JSON zu YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `fr` | 待母语者复核 | `formateur JSON`, `visionneuse JSON`, `comparer JSON`, `JSON vers YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `es` | 待母语者复核 | `formateador JSON`, `visor JSON`, `comparar JSON`, `JSON a YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `es_419` | 待母语者复核 | `formateador JSON`, `visor JSON`, `comparar JSON`, `JSON a YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `pt_BR` | 待母语者复核 | `formatador JSON`, `visualizador JSON`, `comparar JSON`, `JSON para YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `pt_PT` | 待母语者复核 | `formatador JSON`, `visualizador JSON`, `comparar JSON`, `JSON para YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `ru` | 待母语者复核 | `форматирование JSON`, `просмотр JSON`, `сравнение JSON`, `JSON в YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `ar` | 待母语者复核 | `منسق JSON`, `عارض JSON`, `مقارنة JSON`, `تحويل YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `id` | 待母语者复核 | `pemformat JSON`, `penampil JSON`, `bandingkan JSON`, `JSON ke YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `vi` | 待母语者复核 | `định dạng JSON`, `trình xem JSON`, `so sánh JSON`, `JSON sang YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `it` | 待母语者复核 | `formattatore JSON`, `visualizzatore JSON`, `confronta JSON`, `JSON a YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `ro` | 待母语者复核 | `formatare JSON`, `vizualizator JSON`, `comparare JSON`, `JSON în YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `tr` | 待母语者复核 | `JSON biçimlendirici`, `JSON görüntüleyici`, `JSON karşılaştır`, `JSON YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |
| `pl` | 待母语者复核 | `formatowanie JSON`, `podgląd JSON`, `porównanie JSON`, `JSON na YAML`, `JSON5` | `extName` + `extDescription` + 详细描述首段 |

## 复核清单（小语种上线前核对项）

1. 确认所有 `待母语者复核` 语言的名称听起来自然、符合当地开发者常用搜索词，未出现直译腔或词组堆砌。
2. 确认所有 `listing.txt` 前两行（商店折叠显示区）都包含该语言的前 3 个核心关键词。
3. 确认所有 `extName` 长度 ≤ 75 字符、`extDescription` 长度 ≤ 132 字符（由 `npm run check:release` 自动强制校验）。
4. 确认截图顶部标语在 CJK、西里尔字母、越南语变音符号与阿拉伯语 RTL 布局下无截断或字体回退异常。
