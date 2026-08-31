# GameVoiceSubtitle

游戏队友语音实时翻译字幕 Overlay(Windows)。实时捕获语音软件(Discord / YY / KOOK …)里队友说话的声音,经 Silero VAD 过滤后交给阿里云百炼流式识别 + 翻译,以半透明穿透字幕叠加显示在游戏画面上。

```
语音软件进程 → WASAPI 进程级 loopback (48k/16bit/stereo)
            → 重采样 16k/mono/20ms 帧
            → Silero VAD(只有人声段才上行,没人说话零 API 调用)
            → DashScope WebSocket(partial/final 流式结果)
            → SubtitleStore 按 sentence_id 归并
            → 透明穿透 overlay 双行字幕(灰色原文 + 白色译文)
```

## 识别引擎(设置页可切换)

| 引擎 | 模型 | 翻译 | 特点 |
|---|---|---|---|
| **Paraformer(默认)** | `paraformer-realtime-v2` | 句子定稿后由 `qwen-mt-turbo` 翻译回填 | 识别便宜;说话过程中字幕先显示原文,定稿约 0.3–0.5s 后替换为译文 |
| **Gummy** | `gummy-realtime-v1` | 模型内置,partial 阶段即有译文 | 一体式延迟最低;识别+翻译分别计费 |

两条链路共用同一条 WebSocket 通道与全部重连/保活逻辑,共用同一个百炼 API Key。

## 运行要求

- **Windows 10 x64 2004(build 19041)及以上**(进程级 loopback 的硬性要求;不满足时自动降级为全系统采集并提示)
- 阿里云百炼 API Key(在设置页填写,带"测试连接"按钮;计费约 ¥0.00015/秒 × 识别、翻译各一份,设置页有本月估算用量)
- 游戏须以**无边框窗口化**运行(独占全屏拿不到叠加层,本期明确不支持)

## 开发

```bash
npm install
npm run dev        # electron-vite 开发模式
npm run typecheck
npm run build      # 仅构建 bundle
```

macOS/Linux 上可以启动(用于开发 overlay/设置界面),音频采集会明确报"仅支持 Windows"。

### 打包

两个 native 模块(`loopback-capture`、`onnxruntime-node`)都自带 Windows x64 预编译二进制,因此**无需 Windows 机器即可交叉打包**(`npmRebuild: false` 已配置,不会尝试本机重编译)。

在 Windows x64 上:

```bash
npm run pack:win       # NSIS 安装包 + 免安装 zip → dist/
```

在 macOS(Apple Silicon,无 Rosetta)上:electron-builder 自带的 makensis/wine 是 x86 二进制跑不起来,需要两步绕过——

1. `brew install nsis` 装 arm64 原生 makensis,并把 electron-builder 缓存的 `nsis-3.0.4.1` 目录复制一份、将其中 `mac/makensis` 替换为指向 `/opt/homebrew/bin/makensis` 的 shell 包装脚本,构建时传 `ELECTRON_BUILDER_NSIS_DIR=<该目录>`;
2. `win.signAndEditExecutable: false` 已配置(跳过需要 wine 的 rcedit),代价是 exe 保留 Electron 默认图标/版本信息,功能无影响。

```bash
ELECTRON_BUILDER_NSIS_DIR=<shim目录> npx electron-builder --win --x64
```

## 手动验收清单

1. **Overlay 显示层**:启动后托盘出现圆点图标;托盘菜单 → "编辑字幕位置" 能看到示例双行字幕并可拖动;退出编辑后鼠标点击穿透到下层窗口。
2. **音频链路**:设置页选择 Discord.exe(或"全系统音频"),播放声音后 overlay 右下角音量条有响应。
3. **VAD**:有人说话时右下角出现"检测到人声";纯音乐/游戏音效不应频繁触发。没人说话时日志(设置页 → 打开日志目录)中不应产生任何上行秒数。
4. **识别翻译**:填入有效 API Key(测试连接为绿色)后,队友说英语 ≈1.5s 内出现中文字幕,上方一行灰色小字为英文原文;识别中的句子透明度略低,定稿后恢复。
5. **断网恢复**:拔网线 → 状态点变黄(重连中),恢复网络后自动继续,无需重启。
6. **热键**:`Ctrl+Alt+S` 显示/隐藏字幕,`Ctrl+Alt+P` 暂停/恢复识别(可在设置页改)。
7. **API Key 错误**:填错 Key 时状态点变红并弹托盘气泡提示,引导去设置页,不会静默失败、不会无限重连。

## 设计说明 / 取舍

- **连接复用**:一条 WebSocket 跑多个 task,每个 VAD 语音段对应一次 `run-task`/`finish-task`,不重连。
- **保活**:官方无应用层心跳,空闲时每 30s 发 WebSocket protocol ping;若仍被服务端断开(约 60s 空闲策略),关闭事件触发指数退避(1s/2s/4s/8s…上限 30s)透明重连,重连期间音频**丢弃不堆积**。
- **VAD 预滚**:触发前 300ms 环形缓冲随段首一起上行,避免吃掉句子开头;讲话超 30s 强制切段。
- **隐私**:默认日志不含音频与识别文本,设置页打开"调试日志"后才记录;API Key 只存 `electron-store`,不进日志。
- **Overlay 安全边界**:渲染进程零业务逻辑,`contextIsolation: true` + preload 白名单;窗口为 `screen-saver` 置顶层级 + 完全鼠标穿透,不注入任何游戏进程。
- **术语翻译预留**:`GummyClient` 产出的结果统一经 `SubtitleStore.applyResult` 入口;后续若要接 LLM 术语表翻译,在这两者之间插一层 `Translator` 即可,协议类型已隔离在 `src/main/asr/types.ts`。

## 反作弊说明

本工具**不注入任何进程、不 Hook DirectX**,只是普通的置顶透明窗口 + WASAPI 音频采集,原理上与 Discord Overlay、OBS 属同一类。但部分竞技游戏对第三方叠加层有自己的政策,使用前请自行确认所玩游戏的规则。

## 非目标(本期不做)

说话人分离、语音合成朗读、macOS/Linux、独占全屏、本地离线识别。
