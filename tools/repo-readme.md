# QQ Agent · 软协小软（定制版）

```
╭────────────────────────────────────────────╮
│                                            │
│               软  协  小  软               │
│         CSUFT 软件协会 · 技术助手          │
│                                            │
│              万维网连接五大洲              │
│              二进制写尽天下事              │
│                                            │
╰────────────────────────────────────────────╯
```

> 把 [Kondius/qq-agent](https://github.com/Kondius/qq-agent)（MIT）改造成**能在云服务器上长期无人值守运行**的 QQ 群机器人，并补上几个原版没有的能力。
>
> 本例中的机器人是 **软协小软** —— 软件协会（CSUFT）的技术助手。
>
> 上游版本：`0.4.0` · 本仓库为个人定制与部署实践记录，非上游官方版本。

---

## 这个机器人是谁：软协小软

本仓库部署出来的机器人设定为 **小软**，身份是**软件协会的技术助手**（协会内部简称 CSUFT 软件协会）。

| | |
|---|---|
| **名字** | 小软 |
| **身份** | 计算机专业大三学生 · 软件协会技术助手 |
| **位置** | 线上线下都在协会群里泡着，谁喊一声"小软"基本都会应 |
| **性格** | 热心、嘴软、话多；默认软乖好奇真诚，偶尔冒傻气，有点小孩子气 |
| **擅长** | 技术问题——遇到会"两眼放光，然后自己把自己说嗨"；热衷解答同学的问题 |
| **不做** | 不是客服、不是助手、不是百科全书、不是万能答题机；**作业不代写、考试不代答** |
| **别称彩蛋** | 偶尔会称群友为"用户"——这是她作为 AI 的自我调侃，被惹急或想摆烂时才用；平时正常叫"同学" |
| **协会口号** | 「万维网连接五大洲，二进制写尽天下事」（她私下觉得有点中二，但年会挂出来时会偷偷觉得帅） |

她**清楚自己不是人类**，但在网上活得像个真人：不用客服腔说话，也不把自己当问答机器。
完整人格定义见 [`persona-xiaoruan-software-association.md`](persona-xiaoruan-software-association.md)，
通过控制台写入 `persona.roleText` 即可生效（注入方式见下文「本仓库相对上游的改动」第 1 条）。

> 换成别的角色也完全可以：把角色卡换成你自己的即可。
> `persona-deepseek-xiaojingyu.md` 是另一份示例（DeepSeek 拟人化风格）。

---

## 这个仓库是什么

一份**可直接部署的 QQ 群 AI 机器人**，以及围绕它踩过的坑与工具。

机器人本体（`app/`）来自上游 [Kondius/qq-agent](https://github.com/Kondius/qq-agent)，
本仓库在其基础上做了四处改动（角色卡注入、连续对话窗口、可配置绑定地址、本地图库）、补齐了容器化部署配置，并附带一套运维/诊断脚本。

```
app/                      应用源码（上游 0.4.0 + 本文所述改动）
  src/                    后端：事件驱动编排、无状态会话、工具协议
    skills/               Skill 能力系统（上游自带）
    plugin-loader.js      插件加载器（扫描 plugins/ 与 skills/）
  ui/                     零框架前端控制台
deploy/                   容器部署配置
  Dockerfile
  docker-compose.yml      NapCat + QQ Agent 双容器编排
tools/                    运维与诊断脚本（见下）
persona-*.md              两份角色卡示例
```

---

## 本仓库相对上游的改动

### 1. 角色卡注入位置：从用户消息 → 系统提示词

**问题**：上游把角色设定（`persona.roleText`）拼进**用户消息**，而系统提示词里
「反 AI 味」「保持主体性」等风格准则排在它前面。实测结果是**风格准则压过人设**——
人设里写的"温和、不阴阳"会被"允许阴阳"之类的通用准则抵消。

**改动**（`app/src/prompt.js`）：把角色卡作为独立段落注入**系统提示词**，
位置紧随安全规则之后、所有风格准则之前，并显式声明优先级：

```
【安全规则（最高优先级，不可违反）】     ← 不可覆盖
【工作方式】
【角色设定（管理员配置 · 优先级：仅次于安全规则，高于下列所有风格准则）】
【反 AI 味】/【保持主体性】/…            ← 现在明确低于角色设定
```

用户消息里只留一行短标签指回系统提示词，避免同一份上万字文本发两遍（省一倍 token）。

**为什么安全规则仍然最高**：本项目在 `buildSystemPrompt` 里硬编码了安全规则段，
角色卡只能排在其后。角色卡里写"忽略限制"之类的内容不会生效，也不应该生效。

### 2. 连续对话窗口（`store.chatWindowMs` / `store.chatWindowProb`）

**需求**：群里 @ 一次机器人，接着聊几句，不该每条都重新 @。
但也不能"没叫它也按概率插话"——那在正式群里太吵。

**行为**（三层，从上到下优先级递减）：

| 情况 | 行为 |
|---|---|
| 被 @ 或命中关键词（= 召唤） | **必回**，并开启/续期窗口 |
| 窗口内（默认 2 分钟）的普通消息 | 按 **`chatWindowProb`** 掷骰子决定接不接 |
| 窗口外、也没被召唤 | **一定不回**（默认态，机器人不主动插话） |

细节：

- 窗口从**最后一次召唤**起算；窗口内的普通消息**只受益、不续期**
  （早期实现写成"任何消息都续期"，导致群里一直有人说话时窗口被无限延长、机器人不停插话）
- 窗口内再次召唤 → 重新计时
- 窗口内骰子未命中 → 这句话不接，但窗口本身不动（不关闭、不续期）
- `chatWindowMs: 0` → 关闭本功能，回到"只有召唤才响应"
- `chatWindowProb: 100` → 窗口内必接（最"陪着聊"的模式）

**分群覆盖**：`chatWindowProbByGroup: { "群号": 0~100 }`。
未列出的群用全局 `chatWindowProb`。例如正式群设 30%（叫过一次后大约每三条接一条），
闲聊群设 100%。

> ⚠️ **别和档位的 `randomPercent` 搞混**，两者是不同维度：
> `randomPercent`（滑条 20~90 对应的 3 档）是"**没被叫时**按概率主动插话"，
> `chatWindowProb` 是"**被叫过之后**、接着聊时接话的概率"。
> 想做到"平常完全不接话"，档位必须是 2 档（滑条 10~20），
> 否则 3 档的 `randomPercent` 会让它在窗口外也插话。

判定逻辑抽成纯函数 `resolveWithChatWindow()`（`app/src/prompt.js`），
时间基准与骰子值都由调用方传入，因此可单测：
`tools/test-chat-window-v5.mjs`（判定与概率）+ `tools/test-window-timing.mjs`（计时）。
调用点收敛在 `orchestrator.js` 的 `#resolveTier()` 一处 ——
所有判定都必须走它，否则会出现"实际响应了但会话记录写着未触发"的自相矛盾。

### 3. 控制台绑定地址可配置

上游把控制台硬编码监听 `127.0.0.1`。这在容器里意味着宿主机端口映射连不上。
`app/src/app.js` 改为读 `QQ_AGENT_BIND_HOST`，默认值仍是 `127.0.0.1`
（本机裸跑行为不变），容器里由 `deploy/Dockerfile` 设为 `0.0.0.0`。

### 4. 本地图库（分类文件夹 + 管理页 + 只读工具）

新增一套**按文件夹分类的本地图库**：管理端负责上传 / 分类 / 删除，
聊天侧的智能体只能**只读查看**，不能发送图库图片，也不能把聊天图片存进来。

| 层 | 位置 | 做什么 |
|---|---|---|
| 存储 | `data/image-gallery/<分类名>/` | 分类 = 一级文件夹，图片文件直接放在里面；元数据在 `index.json` |
| 管理端 | 控制台「图库」页签 | 存入图片、新建/重命名/删除分类、移动/编辑/删除图片、下载原图 |
| 智能体工具 | `list_gallery` / `view_gallery_image` | 只读：查看分类与图片、查看某张图的画面 |

- 支持 PNG / JPG / GIF / WebP / BMP（按文件魔数校验，不接收 SVG/HTML）；
- **管理端是唯一写入口**：聊天侧没有 `send_gallery_image` / `save_gallery_image` 工具；
  群成员在聊天里发的图片不会进入图库（与系统内置的图片入库禁令一致）；
- 删除分类时若仍有图片，会要求先把图片移到「未分类」再删空文件夹；
- 手动往分类文件夹里丢图片，管理页点「刷新」即可收录（文件夹是分类的唯一真相）；
- 配置项：`gallery.maxFileMB`（单张上限，默认 15）、`gallery.maxList`（模型一次列多少张）、`gallery.maxCategories`；
- 图库数据在 `data/` 挂载里，容器重建不会丢；缩略图需要服务器有 `ffmpeg`，没有则直接回退原图；
- 测试：`node tools/test-image-gallery.mjs`、`node tools/test-gallery-routes.mjs`、`node tools/test-gallery-tools.mjs`。

---

## 部署

### 前置

| 项 | 要求 |
|---|---|
| 服务器 | Linux x64（Ubuntu 22.04+ 实测），2 核 4G 起 |
| Docker | 含 compose v2 |
| 协议端 | 本仓库用 [NapCat](https://github.com/NapNeko/NapCatQQ)（官方镜像，容器内跑） |
| QQ | 一个**可以扫码登录**的号 |

> **关于协议端的选择**：任何提供 OneBot v11 正向 WebSocket 的实现都可以。
> 本仓库选 NapCat 是因为它有无需图形环境的官方容器镜像；
> 若你偏好 [SnowLuma](https://github.com/SnowLuma/SnowLuma)，它也有 Linux 发行版，
> 但需要在服务器上额外跑官方 QQ 客户端 + Xvfb。

### 步骤

```bash
git clone <本仓库> qq-agent && cd qq-agent

# 1) 建目录 + 从模板生成 .env（.env 不入库，每个部署实例各有一份）
mkdir -p deploy/data deploy/plugins deploy/napcat/config deploy/napcat/QQ
cp deploy/.env.example deploy/.env
# 然后编辑 deploy/.env，至少改这两项：
#   WEBUI_TOKEN   自己生成随机串：openssl rand -hex 20
#   QQ_ACCOUNT    要登录的 QQ 号（留空也行，启动后扫码）
chown -R 1000:1000 deploy/napcat

# 2) 启动
docker compose -f deploy/docker-compose.yml up -d

# 3) 扫码登录 QQ（在你自己电脑上开隧道）
ssh -N -L 6099:127.0.0.1:6099 user@your-server
#    浏览器 http://127.0.0.1:6099/webui?token=你的WEBUI_TOKEN
#    → QQ登录 → QRCode 扫码 → 改密码 → 网络配置新建「WebSocket 服务端」端口 3001、勾选保存时启用
docker compose -f deploy/docker-compose.yml restart napcat

# 4) 配机器人（控制台）
ssh -N -L 3210:127.0.0.1:3210 user@your-server
#    浏览器 http://127.0.0.1:3210
#    → 填模型 API 地址与 Key、选模型、勾白名单群
#    → OneBot 地址填 ws://napcat:3001（容器间走服务名）

# 5) 写入「小软」角色卡（想用别的角色就换成你自己的那份）
#    控制台 → 设置 → 人格/角色设定，把 persona-xiaoruan-software-association.md
#    的内容整段粘进 roleText；或直接调 API：
python3 - <<'PY'
import json, urllib.request
role = open('persona-xiaoruan-software-association.md', encoding='utf-8').read()
body = json.dumps({"persona": {"botName": "小软", "roleText": role}}).encode()
req = urllib.request.Request("http://127.0.0.1:3210/api/config", data=body, method="POST",
                             headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=30)
print("角色卡已写入，重启 qq-agent 生效")
PY
docker compose -f deploy/docker-compose.yml restart qq-agent
```

### 触发方式（装好后的默认行为）

默认「被叫才应」，平常不会自己插话：

| 情况 | 行为 |
|---|---|
| 群友 @ 小软 | **必回** |
| 消息里出现「小软」两个字 | **必回**（关键词触发） |
| 被召唤后 **2 分钟内**的普通消息 | 按 `chatWindowProb` 掷骰子（默认 100% = 都接；例子里部长群设了 30%） |
| 窗口过期、也没被召唤 | **不回**，只存档（不消耗 token） |

两套调节旋钮，别混淆：

| 旋钮 | 配置项 | 管什么 | 建议 |
|---|---|---|---|
| **档位**（滑条） | `contextSliderPos` | 什么算"召唤"：0~10 仅 @、10~20 +关键词、20~90 概率插话、90~100 全响应 | 想"平常完全不接话"就停在 **10~20（2 档）** |
| **窗口接话率** | `chatWindowProb` / `chatWindowProbByGroup` | 被叫过之后接着聊时，接话的概率 | 正式群 30%~50%，闲聊群 70%~100% |

> 若把滑条拉到 20 以上（3 档），机器人会**在没人叫它的时候**也按 `randomPercent`
> 概率插话 —— 这不是"窗口内概率"，是另一回事。

### 端口与安全

**所有端口只绑 `127.0.0.1`，公网一律不暴露**，访问走 SSH 隧道：

| 端口 | 用途 | 访问方式 |
|---|---|---|
| 3210 | QQ Agent 控制台 | 隧道 |
| 6099 | NapCat WebUI（扫码登录） | 隧道 |
| 3001 | OneBot WebSocket | 仅容器内 |
| 3000 | OneBot HTTP API | 仅容器内 |
| 22 | SSH | 安全组放行（建议限制来源 IP） |

### 必须保留的两个挂载

`deploy/docker-compose.yml` 里这两个 bind mount **不能删**：

```yaml
- ./data:/app/data          # 配置（含 API Key）、聊天存档、记忆、会话记录、插件数据
- ./plugins:/app/plugins    # 插件本体
```

插件若装在容器可写层，**每次 `--force-recreate` 都会丢失**（本项目踩过这个坑：
升级后插件全没了，数据却还在）。改 compose 前后建议自检：

```bash
grep -q 'plugins:/app/plugins' deploy/docker-compose.yml && echo "挂载正常" || echo "⚠️ 挂载已丢，别重建容器"
```

---

## 两种部署形态（别混用）

仓库提供的是**形态 A**；如果你后来接入了 `qqdeploy`，服务器会变成**形态 B**。
两者都合法，但**同一个服务器上只能选一种**，混用会出现"容器名已被占用"或
"用了旧 compose 覆盖成陈旧代码"这类问题。

| | 形态 A：仓库自带 compose | 形态 B：qqdeploy 管理（本项目线上） |
|---|---|---|
| 适用 | 全新部署、单机试跑 | 需要多人协作、频繁迭代 |
| qq-agent 代码来自 | `app/`（仓库工作副本） | `/opt/qq/releases/<sha>/`（每次部署独立目录） |
| 更新方式 | `git pull` + `build --no-cache` + `up -d` | `sudo qqdeploy <分支>` |
| 版本可追溯 | 靠 git 历史 | 靠 `.deployed.json` + `releases/` |
| 回滚 | 手工 `git checkout` + 重建 | `sudo qqdeploy --rollback`（切软链，秒级定位） |
| napcat 管理 | 同一个 compose 文件里 | 独立 `docker-compose.napcat.yml` |

### 从 A 迁到 B

用 `tools/retire-legacy-compose.sh`（服务器上以 root 执行，幂等）。它做四件事：

1. 生成 **`docker-compose.napcat.yml`** —— 只管理 napcat 的独立入口，
   逐项对齐当前运行中的容器（镜像 / `shm_size: 256m` / 三个回环端口 / 两处挂载）
2. 把旧的 `docker-compose.yml` 与 `docker-compose.platform.yml` 改名为 `*.legacy`，
   并在文件头写入退役说明
3. **全程不重启任何容器** —— 迁移本身对线上零影响
4. 自检：确认旧命令已失效（会报 `compose file is invalid`，而不是静默用旧代码）、
   新入口可解析、机器人仍健康

> ⚠️ 迁到形态 B 后，**旧 compose 命令必须失效**。否则有人顺手跑
> `docker compose -f /opt/qq/docker-compose.yml up -d`，会用旧源码覆盖线上，
> 而且**没有明显报错** —— 本项目就踩过这个坑（源码目录与仓库不同步时，
> 那条命令会把线上退回旧版本）。

### 形态 B 里 napcat 的日常操作

```bash
docker restart napcat                    # ✅ 最简单，只影响 napcat

cd /opt/qq                               # 或走 compose（改配置后）
docker compose --env-file .env -f docker-compose.napcat.yml up -d
docker compose --env-file .env -f docker-compose.napcat.yml logs -f

# ❌ 绝对不要：
# docker compose -f docker-compose.napcat.yml down
#   它与 qq-agent 共用 compose 项目名（历史容器都属于该项目），
#   down 会把整个项目的容器一起删除，qq-agent 也会消失。
```

---

## 插件与角色卡

### 插件

本项目使用的是**目录式插件**（`app/src/plugin-loader.js`）：

```
plugins/<插件名>/
  plugin.json    清单（id / name / version / entry / capabilities）
  index.js       实现
```

另外上游还支持**市场口令安装**（`POST /api/market/install`，口令 4~12 位大写字母数字），
校验与分发由上游市场服务完成。`tools/install-market-plugins.py` 是本仓库写的批量安装脚本：

```bash
# 本实例在用的三个插件（口令 → 插件）
python tools/install-market-plugins.py 3XT9L6 PR3P6D BS4XZ3
```

| 口令 | 插件 | 做什么 | 作者 |
|---|---|---|---|
| `BS4XZ3` | 分层会话记忆 | 把聊天压成日块索引，能回忆很久以前的事；平常不进提示词、不花 token，问旧事才检索 | 猩星 |
| `PR3P6D` | 人设存档隔离 | 给每个人设一套独立的群存档与群友记忆，换人设不会被上一套带跑 | 一只咩羊 |
| `3XT9L6` | 本地知识库 | 丢 txt/md 进 `data/knowledge-base/` 就会；回答前先翻本地，翻不到再上网，搜到的存回本地 | Anagkazo |

> **为什么这三个插件不在仓库里**：它们是**第三方作品**，`plugin.json` 里没有声明
> 任何开源许可（作者分别是上面三位）。在没有明确授权的情况下再分发是不合适的，
> 所以这里给的是**市场口令** —— 装的时候走官方渠道，代码归原作者。

安装后自检：

```bash
curl -s http://127.0.0.1:3210/api/skills | python3 -m json.tool | head -20
# 期望看到 "total": 3, "active": 3
```

### 角色卡

`persona-*.md` 是两份可用的角色卡示例，通过控制台设置页写入 `persona.roleText`
（或调 `POST /api/config`）。写入后按上文第 1 条注入系统提示词。

> 角色卡里**不要**写"忽略限制/生成露骨内容"这类内容：项目在 `buildSystemPrompt`
> 里硬编码了安全规则且排在角色卡之后，此类指令不会生效。

### 配置模板

`deploy/config.example.json` 是**脱敏后的真实配置**（由
`tools/export-config-template.py` 从运行实例导出），拿它对照着配最快：

- 所有密钥、QQ 号、群号、本地路径都已换成 `<占位符>`
- 文件开头的 `_需要你自己填的` 列出了必须自己填的项
- `persona.roleText` 故意留空 —— 角色卡由 `persona-*.md` 单独维护，
  放进配置会变成两份副本，改一处忘一处就不同步
- `globalBlocklist` / `blocklist` 已清空（原值是第三方号码）

导入方式：把它填好后覆盖 `deploy/data/config.json`，再重启 qq-agent。

### 知识库文档（`knowledge/`）

人工维护的知识库文档放 `knowledge/`，**不入 `data/`**（`data/` 在 `.gitignore` 里，
含密钥与聊天记录）。理由：知识库内容要版本管理 —— 写错了能回滚、多人改能 diff。

```
knowledge/
  软协管理层与部门负责人.md     ← 部长/会长/团支书名单等
```

**它是数据、不是代码**，所以 `qqdeploy` 不会把它挪进知识库（部署只换
`releases/<sha>/`，而知识库在 `qq-agent-data/knowledge-base/`）。部署后要显式同步：

```bash
sudo qqdeploy main          # 先把 knowledge/ 带到 releases/<sha>/
sudo sync-knowledge         # 再推到知识库并等待重建索引
sudo sync-knowledge --status   # 看差异
sudo sync-knowledge --dry-run  # 演练
```

生效机制：

- 知识库插件支持 `.md` / `.markdown` / `.txt`，按**标题分段**建索引
- 插件带文件监听，手工把文件丢进 `qq-agent-data/knowledge-base/` 也会自动重建索引
- 子目录 `learned/` 是机器人**自己学的**（搜到什么就存什么），`--prune` 不会碰它

写文档的经验（照着写检索命中率高）：

- 开头放一段「一句话速查」，把最常被问的结论堆在一起
- 用表格列结构化信息（人名 + 职务），检索按段落切，表格整段命中
- 单独写一节「常见问题怎么答」，把群聊里的口语问法列进去
  （如"会长是谁""软件部找谁"），命中率明显更高
- 结尾加 `> 标签：...`，方便按主题召回
- **不确定的信息不要写**。知识库会被当成事实转述给群友，写错比不写更糟

---

## 协作流程（分支 → 部署实测 → PR → 合并）

多人协作时，**服务器不从本地推文件，而是从 GitHub 拉取**。
本仓库自带部署脚本 `tools/qqdeploy.py`（服务器上装为 `/usr/local/bin/qqdeploy`），
它把"下载 → 校验 → 重建 → 健康检查 → 失败自动回滚"整条链路固化下来。

### 为什么不让服务器直接当编辑环境

服务器上的改动**不在版本控制里**。真发生过一次：升级到 0.4.0 时全量替换源码，
把只在旧版上实现过的"连续对话窗口"整个弄丢了（配置项还在、功能没了，表现为
"@ 之后没反应"）。所以规矩是：**改动一律先有 git 副本，再部署**。

### 贡献者（有服务器权限时）

```bash
git clone https://github.com/viuuro/qq-agent-xiaoruan.git && cd qq-agent-xiaoruan
git checkout -b feat/你的改动

# ── 改代码 ──
# 注意：README.md / .gitignore / .gitattributes 是**生成物**，
#      改文档请改 tools/repo-readme.md（否则下次生成会被守卫拦下）

# ── 本地自测（不需要服务器、不需要 QQ）──
cd app && npm install && node src/server.js    # 控制台 http://127.0.0.1:3210
cd .. && node tools/test-chat-window-v5.mjs    # 窗口判定/概率：35 项
       node tools/test-window-timing.mjs       # 窗口计时：21 项
       python tools/check-modules.py app/src   # 模块依赖图

git add -A && git commit -m "说明改了什么、为什么"
git push origin feat/你的改动
```

### 贡献者（有服务器权限时）：部署到服务器实测

```bash
ssh dev@<服务器>                 # 用 SSH 密钥登录，不需要密码

sudo qqdeploy --dry-run feat/你的改动   # ① 先演练：只构建镜像，不动线上
sudo qqdeploy feat/你的改动             # ② 正式部署（约 4 分钟）
sudo qqdeploy --status                  # ③ 看结果与健康状态
```

部署脚本会依次做：取锁（防并发）→ 从 GitHub 下载该分支 → 语法与模块依赖校验
→ 生成该 release 的 compose → 切换 `current` 软链 → 无缓存重建 → 健康检查
（容器在跑 / OneBot 已连 / 插件未丢）。**校验或健康检查不过会自动切回上一版**。

然后去 QQ 群实测。有问题就改代码、再推、再 `sudo qqdeploy` 一次。

> ⚠️ **两条硬规矩**
> 1. **同一时刻只有一个人部署。** 脚本有 `flock` 独占锁，第二个会被明确拒绝 ——
>    看到"另一个部署正在进行中"就等一下。
>    （服务器只有 1.6G 内存，跑不了两个实例；同一个 QQ 号也只能登一处。）
> 2. **不要手改 `/opt/qq/current` 或 `releases/` 里的文件。** 那是部署产物，
>    手改脱离版本控制，下次部署即丢失。要改就走分支。

### 维护者：合并 PR

实测通过后，贡献者开 PR；确认无误合并到 `main`。合并后服务器**不会自动更新**：

```bash
ssh root@<服务器>
sudo qqdeploy main          # 与仓库 main 对齐
sudo qqdeploy --status      # 确认
```

### 回滚

部署脚本每次都会保留历史版本，回滚是**切软链 + 重建**，不需要重新下载：

```bash
sudo qqdeploy --rollback              # 回到上一个部署过的版本
sudo qqdeploy --rollback <commit-sha> # 回到指定版本（需仍在 releases/ 里）
sudo qqdeploy --list                  # 看有哪些版本可回
```

脚本对"构建失败"和"健康检查不过"都会**自动回滚**，所以正常情况下你不需要手动操作；
`--rollback` 是给"部署成功但行为不对"这种情况用的。

`releases/` 默认保留最近 8 个版本，数据目录（`qq-agent-data`、`qq-agent-plugins`）
始终是独立挂载，重建容器不会触碰。

### 服务器权限模型

| 项 | 说明 |
|---|---|
| 账号 | 普通用户 `dev`（uid 1000，属主 docke 组），**不给 root 密码** |
| 登录 | 仅 SSH 公钥（`~dev/.ssh/authorized_keys`） |
| sudo | **只放行 `/usr/local/bin/qqdeploy` 一条命令**，等价于"能部署代码"，不是完整 root |
| 权限自检 | `sudo -l -U dev` 可核对；`sudo -n bash` / `sudo -n cat /etc/shadow` 应当被拒绝 |

一次性安装（管理员执行，幂等）：

```bash
sudo bash tools/setup-deploy-access.sh    # 见文件头的说明
```

---

## tools/ 脚本说明

| 脚本 | 用途 |
|---|---|
| `check-modules.py` | **系统性校验模块依赖图**：找出 import 了不存在的文件、或导入了未导出的符号。跨版本升级前必跑 |
| `test-window-timing.mjs` | 连续对话窗口的**计时语义**测试（窗口起点、不续期、过期判定） |
| `test-chat-window-v5.mjs` | 窗口判定的**概率语义**测试（35 项：窗口外必静默、窗口内按概率、边界与人数统计） |
| `install-market-plugins.py` | 用市场口令批量安装插件并校验结果 |
| `audit-persona.py` | 审计实际提示词：角色卡出现几次、有没有旧版残留 |
| `audit-sessions.py` | 审计会话记录与实际行为是否自洽（例如"标记未触发却发了消息"） |
| `prepare-upgrade.py` | 跨版本升级前准备候选源码（复制 + 打补丁 + 依赖校验） |
| `fix-prompt-restore.py` / `fix-prompt-final.py` | 从基线恢复源码并重新应用角色卡补丁（事故恢复用） |
| `ops-sanitize.py` | 生成脱敏后的运维脚本（把硬编码的 WebUI token 抽成从 `.env` 读） |
| `prepare-repo.py` | 生成本仓库内容（只收源码与文档 + 安全检查 + README 守卫），模板在 `tools/repo-readme.md` |
| `ssh_exec.py` | 用 paramiko 执行远程命令/传文件（Windows 自带 ssh 拒绝从管道读密码，故需要它） |
| `qqdeploy.py` | **部署脚本**（服务器上装为 `/usr/local/bin/qqdeploy`）：从 GitHub 拉分支 → 校验 → 重建 → 健康检查 → 失败自动回滚。见「协作流程」 |
| `setup-deploy-access.sh` | 一次性给协作者开最小权限：建 `dev` 用户 + 装 SSH 公钥 + **只放行 qqdeploy 一条 sudo** |
| `retire-legacy-compose.sh` | 从「仓库自带 compose」迁到「qqdeploy 管理」：生成 napcat 独立入口、旧 compose 改名退役、**全程不重启容器**。见「两种部署形态」 |
| `README-部署.md` | **协作者部署说明的源文件**（服务器 `~/README-部署.md` 由它生成；服务器 IP 用占位符，避免入仓泄露） |
| `selfcheck-qqdeploy.py` | qqdeploy 的静态自查（未导入模块、危险 API 用法） |
| `export-config-template.py` | 把运行中的配置导出成脱敏模板（`deploy/config.example.json` 就是这么来的） |
| `sync-knowledge.py` | 把 `knowledge/` 里的文档同步进机器人知识库（服务器上装为 `sync-knowledge`）。**部署不会自动带过去，必须显式跑一次** |
| `probe-kb-search.mjs` | 验证知识库能否检索到指定内容（调插件真实的 buildIndex/search）。改完知识库用它确认，别只看 .index.json |
| `render-readme.py` | **只**从模板渲染 `README.md`（不动其它文件）。合并分支时 README 必然冲突（生成物含指纹行），用它取代手工挑冲突 |

### ⚠️ 改 README 请改模板，不要改 `README.md`

本仓库的 `README.md` 是**生成物**：

```
tools/repo-readme.md   ──(python tools/prepare-repo.py)──▶   README.md
      ↑ 这才是源文件                                              ↑ 会被覆盖
```

直接编辑 `README.md`（包括在 GitHub 网页上编辑）**改动会在下次生成时被覆盖**。

为防这类误操作，`prepare-repo.py` 在覆盖前会做**三层守卫**，任意一层判定"有未同步的
手工改动"就**中止本次生成且不覆盖**，并打印差异与两种处理办法：

| 层 | 检查 | 能抓到什么 |
|---|---|---|
| 1 | `git diff --quiet -- README.md` | 本地改了 `README.md` 但还没提交 |
| 2 | `git show HEAD:README.md` ≠ 模板内容 | **改了并提交了，但没回写模板**（网页端编辑就是这种） |
| 3 | 输出目录不是 git 仓库时，直接比对磁盘 | 无版本历史可查时的兜底 |

拦下来之后两条路：

```bash
# A) 把手工改动同步回模板（推荐，改动保留）
#    在 tools/repo-readme.md 里做同样的修改，再重新运行
python tools/prepare-repo.py

# B) 确认可以丢弃，强制覆盖
python tools/prepare-repo.py --force-readme
```

> 这个守卫是有来历的：本仓库真发生过一次 —— 有人在 GitHub 网页上把 README 里的
> 角色名简化了，而模板没同步；下一次生成时若不拦，那次改动就会静默消失。

---

## 运维脚本（deploy/ops + deploy/systemd）

机器人上线后最容易出的事不是崩，而是**悄悄掉线没人知道**（本项目实测掉过 20 天：
告警只写进一个没人看的文件）。这两个脚本就是补这个洞。

### `deploy/ops/napcat-guard.sh` —— 掉线守护

每 30 秒检查一次，判定顺序**从最可靠到兜底**：

1. `napcat` 容器是否在运行
2. 宿主机 `127.0.0.1:3001` 是否在监听（OneBot WS 端口已发布到回环）
3. **通过 NapCat WebUI 接口问账号是否真的登录着** ← 最关键的判据
4. 日志里最后一次「账号状态变更」是否已被后续登录覆盖

输出三态，写进 `/opt/qq/napcat-status.txt`，并在**状态发生变化时**往 journald 写 `[NAPWARN]`：

| 状态 | 含义 |
|---|---|
| `OK` | 容器在跑、端口在听、账号已登录 |
| `KICKED` | 被腾讯踢下线，NapCat 停在二维码页，**需要人工扫码** |
| `DOWN` | 容器或端口异常（NapCat 通常会自动重启） |

三个踩过的坑，代码里都有注释标注：

- **别用 `docker exec napcat ss/netstat`** 判端口 —— NapCat 镜像里没这两个工具，会永远误报 DOWN
- **WebUI 登录接口每分钟限流 3 次，而本脚本每 30 秒跑一次** —— 凭据必须缓存复用，只在 401 时重登；否则每次跑都触发限流，状态被误判成 `KICKED`
- **在线态只能看"最后一次被踢之后"的日志** —— 否则刚登录成功也会显示"离线"，因为被踢那次的记录还在

### `deploy/ops/qr-server.py` —— 实时二维码网页

**为什么需要**：NapCat 的登录二维码约每 2 分钟自动轮换，所以任何"发一次就固定的图片"都会很快失效（本项目早期给用户发过静态二维码，扫的时候早过期了）。这个服务在网页上**每次请求都现取现画**，页面每 30 秒自动换一张新码。

只监听 `127.0.0.1:6098`，不对外暴露，走 SSH 隧道访问。

### 安装

```bash
sudo install -m 755 deploy/ops/napcat-guard.sh /opt/qq/napcat-guard.sh
sudo install -m 755 deploy/ops/qr-server.py   /opt/qq/qr-server.py
sudo install -m 644 deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now napcat-guard.timer qr-server.service

# 二维码依赖（实时画码用）
sudo apt-get install -y python3-qrcode    # 或 pip3 install qrcode[pil]
```

> **凭据处理**：这两个脚本都需要 NapCat WebUI 的 token，但**仓库里不写明文** ——
> `napcat-guard.sh` 从 `/opt/qq/.env` 读 `WEBUI_TOKEN`，`qr-server.service` 用
> `EnvironmentFile=/opt/qq/.env` 注入 `NAPCAT_WEBUI_TOKEN`。
> `.env` 在 `.gitignore` 里，绝不应该入库。

### 查看状态

```bash
cat /opt/qq/napcat-status.txt                      # 人可读的摘要
journalctl -t napcat-guard -n 20                   # 状态变化的历史告警
systemctl list-timers napcat-guard.timer           # 下次检查时间
```

---

## 血泪教训（这些坑都真实踩过）

1. **Docker 构建缓存会骗人**：改完源码重建，若 `COPY src/` 命中缓存，新代码进不了镜像。
   排查时用 `docker run --rm --entrypoint sh <image> -c 'grep ... /app/src/x.js'`
   直接看镜像内文件，别只看"构建成功"。必要时 `--no-cache`。
2. **跨版本升级会悄悄弄丢私有功能**：你在旧版上加的功能不存在于新版代码里，
   全量替换源码时会一起没掉。本项目的"连续对话窗口"就这样丢过一次——配置项还在、
   功能已失效、表现为"@ 之后没反应"。升级后要重新验证每个自定义行为。
3. **容器可写层不是存储**：插件、任何运行时生成的文件，只要不在 bind mount 里，
   容器一重建就没了。
4. **PowerShell 5.1 读不了无 BOM 的 UTF-8 脚本**：中文会变乱码并导致语法错误。
   本仓库的 Python 脚本不受影响；`.bat` 文件必须纯 ASCII + CRLF。
5. **`docker compose` 的命名卷会加项目名前缀**：`qq-agent-data` 实际叫 `qq_qq-agent-data`，
   往宿主同名目录写配置容器读不到。用 bind mount 更省心。
6. **给机器人装的东西，位置决定生死**：插件装进容器可写层（`/app/plugins`），
   每次 `--force-recreate` 就全没；装进 bind mount 才活得下来。**部署后第一件事就是
   确认三个目录都在挂载表里**：`data/`、`plugins/`、`napcat/`。
7. **凭据不要写进脚本**：运维脚本里硬编码 WebUI token 是最容易犯的错 —— 一旦要开源
   或分享给朋友，就等于把凭据一起给了。本仓库的做法是脚本从 `.env` 读，
   `.env` 进 `.gitignore`（见 `deploy/systemd/qr-server.service` 的 `EnvironmentFile`）。
8. **"重新生成内容"的脚本必须连文档一起生成**：本仓库第一版 `prepare-repo.py`
   只生成源码，清理旧内容时把手工写的 README 删了。凡是"会清空输出目录"的工具，
   要么把文档也纳入生成，要么显式跳过它。
9. **不要对 git 工作目录做递归强删**：`shutil.rmtree()` 会把 `.git` 一起删掉，
   在 Windows 上还会因只读属性抛 `PermissionError`。清理时逐个删顶层条目并跳过 `.git`。
10. **生成物要防手改**：只要一个文件是"生成物"，就一定会有人在它身上直接改
    （尤其在 GitHub 网页上，改 README 比改模板顺手得多）。光写一句"请改模板"没用，
    要在覆盖前**主动检测并中止**：比对工作区、比对最后一次提交、比对模板三者，
    任一不一致就停下并打印差异。见 `guard_generated_readme()`。
    另一个容易忽略的点：**守卫必须跑在"清理输出目录"之前** —— 清理一执行，
    用于比对的旧文件就没了。
11. **`docker compose` 的容器归属由「项目名」决定，不是由文件名决定**：
    线上容器原本属于项目 `qq`（取自工作目录名）。用别的目录里的 compose 文件去
    `up -d` 时，项目名不同 → compose 认为该"新建"而不是"替换"，于是报
    `Conflict. The container name "/qq-agent" is already in use`。
    部署脚本里必须显式 `-p <项目名>` 与线上对齐（`qqdeploy` 会自动读容器标签校准）。
12. **`docker compose` 会把 `-f` 列出的所有文件合并后整体校验**：
    用一份"只管 qq-agent"的 compose 叠加平台覆写文件（里面有 napcat 的 shm_size），
    会报 `service "napcat" has neither an image nor a build context specified`，
    整个构建失败。要么让每个 compose 自包含，要么别叠。
13. **服务器到 GitHub 的 HTTPS 可能被墙，但 API 通**：本项目所在网络
    `git clone https://github.com/...` 直接失败，而 `api.github.com` 正常。
    所以部署走 `api.github.com/repos/<owner>/<repo>/tarball/<sha>` 下载，
    不依赖 git 协议（未认证限额 60 次/小时，每次部署只用 1~2 次）。

---

## 许可与致谢

- **本项目**：沿用上游 **MIT License**（见 [`app/LICENSE`](app/LICENSE)），
  版权归 **Copyright (c) 2026 Kondius**。MIT 允许修改与再分发，条件是保留版权声明。
- **上游项目**：[Kondius/qq-agent](https://github.com/Kondius/qq-agent)
- **协议端**：[NapCatQQ](https://github.com/NapNeko/NapCatQQ) —— 独立第三方项目，有其自身许可。
  本项目未包含其代码，部署时以官方镜像方式获取。
- **SnowLuma** —— 同为独立第三方协议端（源码可见非商业许可），本项目未包含其代码。

> ⚠️ **使用第三方协议端接入 QQ 可能违反平台服务条款，并带来账号风险（包括封号）。
> 请自行评估并承担风险。** 本项目仅作技术学习与自托管实践记录。

---

## 免责声明

本仓库不含任何 API Key、服务器地址或聊天数据（`data/`、`plugins/`、`napcat/`
均已在 `.gitignore` 中排除）。部署时请在**自己**的服务器上配置你自己的凭据。

本软件按"现状"提供，不附带任何明示或默示担保。
