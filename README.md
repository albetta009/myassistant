# MY Assistant

一个本地跑的 QQ 聊天机器人程序：有人格卡、长期记忆、情绪、表情库和语音（本机 SAPI / Breeze Blue）。

> **想直接运行？** 去 [Releases](../../releases) 下载 `MYAssistant-clean-*.zip`（解压即用，约 140 MB，含 Node 和协议端）。
> 下面是从源码/首次配置开始的说明。

---

## 一、先决条件

- Windows 10 / 11
- **装好 Windows 版 QQ 并保持能登录**（协议端 SnowLuma 是通过注入本机 QQ 进程工作的）
- 能装/已有 **WebView2 Runtime**（Win11 自带；Win10 若启动器白屏，去微软官网装一下）
- 一个能登录的 QQ 号
- 一个模型 API Key（推荐 DeepSeek：https://platform.deepseek.com/ ）
- 可选：Breeze Blue 的 TTS Key（想要在线音色时用）

---

## 二、第一次启动

1. 解压到一个**固定目录**（不要放在 C:\Program Files，路径里尽量不要有空格）。
2. 双击 `MYAssistant.exe`。
3. 点顶部「启动全部」：
   - 会先拉起协议端 **SnowLuma**（端口 3001）和核心（端口 3110）。
   - 第一次启动 SnowLuma 会随机生成一个 **WebUI 初始密码**，打在启动器的「日志」面板里，长这样：
     `initial credentials: user=admin password=xxxxxxxx`
     拿它在浏览器登录，然后立刻改成你自己的密码（不改的话下次启动会重新生成）。
4. 浏览器打开 SnowLuma 控制台：**http://127.0.0.1:5099**
   - 用上面的初始密码登录（admin / xxxxxxxx）并改密
   - 扫码 / 密码登录你的 QQ
5. 在 SnowLuma 里配置 OneBot（**关键一步**）：
   - 新建 **WebSocket 服务端**：`127.0.0.1:3001`，accessToken 填 `aiwo-2026-local`
   - 需要 HTTP 的话再加一个 `127.0.0.1:3000`，token 同上
   - （token 想改的话，同时改 `app/config/config.json` 的 `onebot.accessToken`）
6. 回启动器，点「重启核心」。状态栏显示「协议端在线 / 核心在线」就好了。

> 如果你更习惯 NapCat：把 `launcher.json` 里的 `ProtoKind` 改成 `napcat`、`ProtoPort` 改成 `3000`，再自己装 NapCat。这个包默认只带 SnowLuma。

---

## 三、配置模型

打开控制台：**http://127.0.0.1:3110** → 设置

- **服务商**：DeepSeek（默认）
- **API Key**：填自己的 key（只存在本机 `app/config/secrets.json`，不会上传）
- 模型名默认 `deepseek-flash`；点「测试连接」确认
- 保存后，在「权限」页把自己的 **QQ 号**填成 owner（否则默认谁都不回）

---

## 四、可选：语音

设置 → 语音（TTS）：

- **本机 SAPI**：离线、免 key，音色是系统自带的（默认）
- **Breeze Blue**：在线，需要 key（https://breezeblue.ai/zh/app/developer/api-keys ）
  - 填 key → 「加载音色」→ 选一个 → 「试听一句」→ 保存
  - 基础地址默认 `https://api.breezeblue.ai`（若你的网络下 `api.breeze.blue` 更快，可以改）

她会不会主动发语音，在「调参 → 表情与语音 → 允许她发语音」控制。

---

## 五、目录说明

```
MYAssistant.exe        启动器
launcher.json          启动器配置（端口、协议端类型）
app/core/              核心：聊天、记忆、情绪、表情、语音
app/ui/                控制台前端
app/config/personas/   人格卡（自带的几张示例，可自己写）
app/config/config.json 主配置
app/config/secrets.json  密钥（首次保存后才会有）
app/data/              记忆数据库、表情、图片、语音缓存（首次启动自动创建）
runtime/node/          核心用的 Node
runtime/snowluma/      QQ 协议端（SnowLuma）
logs/                  运行日志
```

---

## 六、常见问题

- **启动器白屏**：缺 WebView2 Runtime。
- **核心在线但没人回**：`权限` 页没填 ownerQQ，或 QQ 没登录 / OneBot 没配对（端口 3001、token 要对上）。
- **端口被占**：改 `launcher.json` 的 `CorePort` / `ProtoPort`，同步改 `app/config/config.json` 里的 `onebot.wsUrl`。
- **想换人格**：控制台「人格」页选卡 → 设为当前人格，下一条消息生效。
- **数据在哪**：`app/data/memory.db`（SQLite）。想清空记忆就停核心后删掉它。
- **备份**：直接复制整个目录即可；`app/data` 是全部记忆。

---

## 七、说明

- 人格卡、表情库、语音都是本地生成/收集的，不含任何第三方版权素材（自带表情库为空）。
- 这个包**不包含**作者的 API Key、聊天记录、QQ 号、主题背景图和个人配置。
- 第一次运行时 `app/data` 是空的，属于正常现象。

---

## License

[MIT](LICENSE) © 2026 albetta009
