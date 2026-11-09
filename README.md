# nestbot

基于 [Kyouka](https://github.com/ayaka-space/Kyouka) 点歌机器人的自研增强整合：**官方语音 API 播放器** + **进频道欢迎播报**。

## 组件结构

```
nestbot/
├── khl-voice/           # 语音播放器（Docker 镜像，基于 KOOK 官方语音 API）
├── kyouka-welcome/      # 欢迎播报模块（合并进 Kyouka 容器）
├── patches/             # Kyouka 增量补丁（本地网易云 API）
└── tools/               # 工具脚本
```

### 1. khl-voice — 语音播放器

极简 Docker 播放器容器：接收音频 URL，加入指定语音频道并推流播放。

- 基于 **KOOK 官方语音 API**：`/api/v3/voice/join` → 按服务端返回码率推流 → 每 45s `keep-alive` → 结束 `leave`
- 环境变量：

  | 变量 | 说明 |
  |---|---|
  | `TOKEN` | 机器人 token |
  | `CHANNEL` | 目标语音频道 id |
  | `SOURCE` | 音频 URL（http/https）或本地文件 |
  | `REPEAT` | `true` 循环 / `false` 播一次后退出 |

- 构建：`docker build -t shuyangzhang/khl-voice ./khl-voice`

> **为什么重写**：旧版播放器固定以 128kbps 推流，而 KOOK 要求推流码率不得超过服务端要求值的 **120%**（实测频道要求 32kbps），超限会被服务端数秒后强制切断——表现为「歌播几秒就没声音」。本版本严格使用 join 返回的 bitrate 推流。

### 2. kyouka-welcome — 欢迎播报

用户进入语音频道时自动播报「欢迎 xx 进入频道」（Tingting 中文语音）。

- `deploy/welcome.py`：新模块。监听 `JOINED_CHANNEL` 系统事件 → 过滤（频道白名单 / 机器人自身 / 冷却）→ 进入欢迎队列
- `deploy/interval_tasks.py`：在 Kyouka 的 5 秒心跳中挂钩——**空闲时立即播报；放歌时在歌曲间隙插播**（上一首结束后、下一首开始前），不打断正在播放的歌曲
- `deploy/main.py`：导入欢迎模块 + 启动时清理遗留容器（在原版基础上仅新增两行）
- `tts-service.mjs`：主机侧 TTS 微服务（macOS `say` → ffmpeg 前加 4 秒静音 → HTTP 提供给容器下载）
- `deploy.sh`：把三个文件 `docker cp` 进 `kyouka` 容器并重启

> **为什么有 4 秒前导静音**：机器人加入频道后，成员客户端订阅音频流约需 2 秒；若直接播报，开头会被吞掉（实测只听到句尾）。前导静音保证整句都能被听到。

> **为什么放歌时是「歌曲间隙」**：同一个机器人同一时间只能在一个语音频道里，放歌时无法同时进另一个频道播报；因此欢迎会排队到当前歌曲结束的间隙播放。

环境变量（均有默认值，可不配置）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WELCOME_CHANNELS` | 游戏+音乐频道 id | 监控的频道（逗号分隔） |
| `WELCOME_TEMPLATE` | `欢迎 {name} 进入频道` | 播报模板 |
| `WELCOME_COOLDOWN_MS` | 60000 | 同一用户冷却 |
| `WELCOME_MAX_AGE_MS` | 600000 | 排队过期时间 |
| `WELCOME_MAX_QUEUE` | 5 | 队列上限 |
| `WELCOME_TTS_BASE` | `http://host.docker.internal:8799` | TTS 服务地址 |
| `WELCOME_GUILD` | - | 服务器 id（查询昵称用） |

TTS 服务变量：`TTS_PORT`（8799）、`TTS_VOICE`（Tingting）、`TTS_LEAD_SILENCE`（4）。

### 3. patches — 网易云本地 API 补丁

`search.py` / `details.py`：把网易云请求指向本机 `ncm-api`（`http://host.docker.internal:3000`），替代失效的第三方代理。

### 4. tools

- `announcer.mjs`：早期独立播报脚本（轮询模式），已被 kyouka-welcome 取代；保留作调试备用（`--probe` 查频道成员、`--test` 试播）
- `list_kook_ids.py`：查询 KOOK 频道/用户 id 的小工具

## 部署

前置：Docker Desktop、Kyouka 容器（名为 `kyouka`）、macOS（TTS 依赖 `say`）、Node.js ≥ 18、ffmpeg、本机 ncm-api（端口 3000）。

```bash
# 1. 构建播放器镜像（Kyouka 按此镜像名创建播放容器）
docker build -t shuyangzhang/khl-voice ./khl-voice

# 2. 启动 TTS 服务（保持运行；电脑重启后需重新拉起）
cd kyouka-welcome
nohup node tts-service.mjs > tts-service.out 2>&1 &

# 3. 部署欢迎模块（docker cp 进容器并重启）
./deploy.sh

# 4. 验证：进入监控中的语音频道，应听到欢迎播报
#    日志：docker logs kyouka | grep welcome
```

## 运维备忘

- **Kyouka 容器重建**（升级镜像等）后补丁会丢失，重跑 `kyouka-welcome/deploy.sh` 即可
- TTS 服务日志：`kyouka-welcome/tts-service.out`
- 欢迎播报日志：`docker logs kyouka | grep welcome`

## 踩坑记录

1. **码率限制**：推流码率 > 服务端要求 × 120% 会被强制切断（详见上文）
2. **同一机器人一个语音频道**：音乐与播报互斥，欢迎只能排到歌曲间隙
3. **同一 token 第二个网关连接会被踢**：KOOK 服务端约每 30 秒断开同一机器人的第二个 WebSocket 长连接，独立进程不要另开网关；本方案直接复用 Kyouka 自身的连接
4. **订阅延迟**：机器人入房后约 2 秒客户端才开始出声，短音频务必加前导静音

## 来源与致谢

- 点歌机器人：[ayaka-space/Kyouka](https://github.com/ayaka-space/Kyouka)
- 语音推流：KOOK 官方语音 API
- 播放器重写、欢迎模块、补丁整合：本仓库
