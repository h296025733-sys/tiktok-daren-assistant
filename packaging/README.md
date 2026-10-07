# Windows 内部体验包

目标产物是 Windows 10/11 x64 当前用户安装包：

- Chrome 扩展只包含 `extension/dist` 的生产运行文件；
- 后端使用 PyInstaller `onedir`，不依赖同事电脑上的 Python、Node.js 或 Codex；
- 初始 ZIP 不包含任何 Whisper/Argos 模型、数据库、下载结果或日志；
- 安装位置固定为 `%LOCALAPPDATA%\TikTokDarenAssistant\app`；
- 可变数据分别写入同级 `data`、`models`、`outputs`、`logs`、`run` 和 `cache`；
- 安装器创建当前用户 Startup 快捷方式，不需要管理员权限，也不修改 Chrome 企业策略。

## 构建

在已经运行过项目开发环境安装的 Windows x64 机器上执行：

```powershell
backend\.venv\Scripts\python.exe -m pip install -r packaging\requirements-build.txt
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build_release.ps1
```

构建脚本默认先运行插件全量测试、类型检查、生产构建和后端测试。只有在外层 CI 已经完成完全相同的验证时，才可使用 `-SkipValidation`。

输出：

```text
release\TikTokDarenAssistant-v<version>-win-x64.zip
release\TikTokDarenAssistant-v<version>-win-x64.zip.sha256.txt
```

`release/` 已被 Git 忽略。构建脚本采用发行白名单，并在压缩前拒绝 `.venv`、`models`、`node_modules`、`tests`、`outputs`、`logs`、`data`、数据库、模型和 Python 缓存进入产物。

## 人工验收

必须在一台没有 Python、Node.js、Codex 和既有模型的干净 Windows x64 用户环境中验证：

1. 解压并运行 `0-先运行-安装.cmd`，不触发管理员提升；
2. `http://127.0.0.1:8765/health` 返回与扩展清单一致的版本；
3. Chrome 打开扩展管理页，加载安装器打开的稳定 `extension` 目录；
4. 重新登录 Windows 后，Startup 快捷方式能隐藏启动服务；
5. Google 翻译可用时不创建或下载 Argos 模型；
6. 首次生成字幕时才提示 Whisper 模型，确认后展示进度并安装到 `models`；
7. 端口 8765 被未知程序占用时明确失败，绝不结束未知进程；
8. 普通卸载保留 `models` 与 `data`，显式清数据卸载才删除整个产品目录；
9. Chrome 另存到外部目录的文件不受卸载影响；
10. 校验 ZIP 的 SHA-256，并扫描 Windows Defender/公司终端安全软件告警。

## 发布限制

普通 Windows Chrome 不允许本地 CRX 静默安装，因此体验包只能引导“加载已解压的扩展程序”。正式规模化发布应改为私有 Chrome Web Store 或公司托管扩展策略，并为后端可执行文件配置公司代码签名。
