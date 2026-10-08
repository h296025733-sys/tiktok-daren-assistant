# TikTok 达人助手

**把达人与视频数据、批量下载、评论翻译和字幕放进浏览器工作流。**

查看达人主页时，我希望在当前页面完成筛选、比较和素材整理；刷视频时，希望字幕与评论翻译跟得上正在看的内容。这个 Chrome MV3 扩展围绕这两种使用场景组织功能。

当前源码版本为 `0.1.28`，主线使用 Chrome-only 构建，浏览器版主要功能不依赖本地后端。仓库保留了早期服务与授权实现，也记录了当前未通过的测试。

## 两种页面，两类操作

| 页面 | 操作 |
| --- | --- |
| 达人主页 | 读取公开字段，排序、筛选与多选，下载视频、音频或批量 ZIP。 |
| 当前视频 | 获取当前视频数据，翻译评论，预览与导出字幕，显示双语结果。 |

字段缺失时保留空值。字幕优先使用平台文本，再按需使用浏览器 Whisper；语音模型有下载与缓存流程。

## 动态页面里的状态问题

**同一个 DOM 节点未必还是同一条视频。** 活动视频会话按视频键和页面 URL 管理缓存，观察到切换时清空当前结果；过期结果需要经过归属判断才能使用。

**字幕和翻译也要按视频保存。** 字幕缓存按视频 ID 组织，译文再按目标语言保存，读取时检查结构与容量。侧栏中的异步识别、取消和新视频排队共同参与切换流程。

**页面数据来源有不同可信度。** 提取层分别处理 DOM、结构化数据和页面桥接信号，记录证据与缺失字段。评论翻译则需要处理滚动带来的节点复用和重复内容。

**下载是一条单独的任务链。** 媒体解析、卡片队列、批量限制、命名、文件保存与 ZIP 写入各有模块，界面可以展示逐项进度与失败。

## 读代码可以从这里开始

| 关注点 | 入口 |
| --- | --- |
| 活动视频与结果归属 | [session.ts](extension/src/content/session.ts) · [activeVideo.ts](extension/src/extractors/activeVideo.ts) |
| 多来源提取与证据 | [extractors/](extension/src/extractors/) · [evidence.ts](extension/src/content/evidence.ts) |
| 字幕缓存与侧栏流程 | [subtitleSessionCache.ts](extension/src/sidepanel/subtitleSessionCache.ts) · [sidepanel/index.ts](extension/src/sidepanel/index.ts) |
| 评论翻译与请求队列 | [content/translation.ts](extension/src/content/translation.ts) · [foregroundQueue.ts](extension/src/translation/foregroundQueue.ts) |
| 批量下载与文件输出 | [downloads/](extension/src/downloads/) |

## 本地开发

建议 Node.js 20+ 和 pnpm。

```powershell
cd extension
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
$env:TDA_CHROME_ONLY_BUILD = "1"
pnpm build
Remove-Item Env:\TDA_CHROME_ONLY_BUILD
```

在 Chrome 扩展页加载 `extension/dist`。重新构建后，要重新加载扩展并刷新已经打开的 TikTok 页面。

## 仓库结构

`extension/` 是当前主线；`backend/`、`license-worker/` 和 `packaging/` 保留早期服务、授权与打包实现，Chrome-only 主线不依赖这些服务。`scripts/` 保留构建与检查入口。

翻译依赖网页接口，可能限流；浏览器语音识别的第一次使用需要下载模型。公开版移除了硬编码翻译 API Key；没有自行配置授权的 HTML 翻译通道会跳过，其余网页翻译路径保留。

Chrome-only 配置下的完整测试套件仍有 15 项失败；6 个浏览器专用侧栏用例单独运行均通过。测试模式与共享状态的问题尚待整理，具体结果见检查记录。

TikTok 页面结构、地区和账号实验会影响提取效果。源代码公开展示没有替代真实页面的功能验收；第三方模型和依赖的归属保留在各自包与配置里。

## 本次公开整理的检查

见 [检查记录](docs/verification.md)，其中区分源码与语法检查、隔离测试和未执行的真实环境路径。
