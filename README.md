# TikTok 达人助手

这是我做的一个 Chrome 扩展，平时用来查看 TikTok 达人和视频数据，也把下载、评论翻译、字幕生成这些常用操作放到了一起。

当前源码版本为 `0.1.28`，主要使用 Chrome-only 构建。加载扩展即可使用主要功能，不需要另外启动本地服务。

## 现在能做什么

- 读取 TikTok 页面已经公开的达人与视频数据；缺失字段保留空值。
- 在达人主页排序、筛选、多选，下载视频、音频或批量 ZIP。
- 单条和自动评论翻译，复用已经翻译的内容，处理滚动与 DOM 节点复用。
- 字幕优先读取平台已有文本，没有时再使用浏览器 Whisper。
- 字幕翻译、双语显示和视频切换后的结果隔离。
- 按需下载和缓存语音模型，避免每次重新准备。

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
