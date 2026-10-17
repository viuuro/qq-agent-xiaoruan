<!-- generated-from: tools/repo-readme.md sha256:69c0c1bc00a7fabc61946ee3054dfc60918a54caa27e1ed616459480475c13e5 -->
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
本仓库在其基础上做了三处代码改动、补齐了容器化部署配置，并附带一套运维/诊断脚本。

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

## 两种部署形态

| | 形态 A：仓库 Compose | 形态 B：qqdeploy |
|---|---|---|
| 应用代码 | Git 工作副本的 `app/` | `/opt/qq/releases/<sha>/` |
| 应用数据 | Compose 文件旁的 `data/`、`plugins/` | 经核对的独立数据及插件挂载 |
| 更新方式 | 拉取代码、构建并重建 | `sudo qqdeploy <分支或SHA>` |
| 版本记录 | Git 历史及管理员备份 | `.deployed.json`、操作记录及历史镜像 |

### 迁移前先核对线上实际状态

`tools/retire-legacy-compose.sh` **只负责已完成 qqdeploy 接管后的入口退役**，不会搬运运行数据，也不会停容器。它会核对当前部署状态及实际挂载；未满足接管条件时拒绝退役。

管理员先只读检查：

```bash
docker inspect qq-agent --format '{{json .Mounts}}'
docker inspect napcat --format '{{json .Mounts}}'
readlink -f /opt/qq/current
```

不要根据空目录或仓库示例判断线上数据在哪里。从 A 迁移到 B 时，应先完成：

1. 记录实际 Compose 项目、网络、挂载源路径和 UID/GID；备份应用源码、配置、插件与 NapCat 状态。
2. 安排维护窗口，暂停应用写入，用保留属性的复制方式迁移确需调整的目录；校验内容、权限，保留源目录。NapCat 登录态不能落到空目录。
3. 安装管理员审核的部署工具，准备可回退的基线版本与镜像，确认 B 使用的是已有数据。
4. 完成一次部署和健康检查后，才执行退役脚本。若服务器已经是 B，跳过数据搬运。

```bash
sudo bash tools/retire-legacy-compose.sh
```

脚本先生成临时 Compose 并校验，再用唯一备份名保存旧文件；失败时恢复已修改的入口。NapCat 的网络、挂载与运行身份以现有容器为准。迁移期间不执行 `down` 或删除旧数据目录。

### 形态 B 的日常操作

协作者通过受控入口查看日志、重启 NapCat；管理员保留底层 Compose 运维权限。具体命令见 [协作者部署说明](tools/README-部署.md)。不要再用旧 Compose 构建应用，也不要在共享网络上随意执行 `down`、`--remove-orphans`。

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

---

## 协作流程（分支 → 验证 → PR → 部署）

代码先进入 Git，再部署到服务器。贡献者向约定的协作仓库提交 PR；自己的 fork 与部署器允许的仓库必须明确区分，管理员安装部署器时核对其仓库配置。

### 贡献者本地验证

```bash
git checkout -b fix/你的改动
npm install --prefix app
node tools/test-chat-window-v5.mjs
node tools/test-window-timing.mjs
python3 tools/check-modules.py app/src
git diff --check
```

有行为变更时运行对应回归测试。PR 写清问题、变化、测试结果和兼容性影响。README 的源文件是 `tools/repo-readme.md`。合并与部署分开进行，不从本地整目录覆盖服务器。

### 管理员安装可信部署工具

从已审核的仓库副本运行安装器，显式提供协作者账户和公钥；不再使用内置第三方密钥：

```bash
sudo bash tools/setup-deploy-access.sh --user dev --pubkey-file /path/to/collaborator.pub
```

安装器维护 root 所有且协作者不可写的 `/usr/local/bin/qqdeploy`、可信校验器和构建模板。代码校验使用受限账户，分支中的脚本不能作为宿主 root 执行。安装器不会静默撤销已有组权限；管理员需核对旧的 Docker 组及 sudo 授权，安排新会话生效，并保留可用管理通道。

部署源由管理员在 `/etc/qqdeploy/repositories.json` 的 `allowed` 与 `default` 中配置，默认是 `viuuro/qq-agent-xiaoruan`。要部署自己的 fork，先由管理员审核并更新配置；调用者环境变量不能替换部署仓库。

### 部署与失败恢复

```bash
sudo qqdeploy --dry-run main
sudo qqdeploy main
sudo qqdeploy --status
sudo qqdeploy --rollback
sudo qqdeploy --rollback <完整或唯一前缀SHA>
sudo qqdeploy --list
```

部署器把分支固定到完整 SHA，校验源码并构建对应版本镜像，构建成功后才切换容器。演练不切换容器或生产部署记录。健康检查验证容器、OneBot 和部署前启用的插件清单；初始没有插件是合法情况。

构建、切换或健康检查失败时，工具尝试恢复原版本并验证。**只有恢复健康后才报告回滚成功**；恢复失败会明确报错并保留操作记录，管理员根据实际容器、软链及记录处理。首次接管没有可回退版本时拒绝把“没有旧版本”当作恢复成功。

`releases/` 默认保留最近 8 个版本，当前和上一个版本受保护。回滚目标必须是受管理目录中的已知 release，不能传任意服务器目录。部署锁覆盖切换和恢复全过程。

### 权限与运维入口

协作者不需要 Docker socket、通用 Docker CLI 或完整 sudo。已有的 Docker 组成员资格需由管理员审计撤销；仅安装新版脚本不会自动消除旧权限。

```bash
sudo qqdeploy --logs qq-agent
sudo qqdeploy --logs napcat
sudo qqdeploy --restart-napcat
```

日志入口只允许固定容器和受限输出；NapCat 重启会短暂断开 QQ，执行前与其他协作者协调。管理员应核实 SSH host key 指纹，并维护授权公钥与部署账户，禁止共享 root 密码。

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
| `ops-sanitize.py` | 从仓库运维源文件生成不含凭据的运维包，拒绝覆盖源码或复制外部旧快照 |
| `prepare-repo.py` | 生成本仓库内容（只收源码与文档 + 安全检查 + README 守卫），模板在 `tools/repo-readme.md` |
| `ssh_exec.py` | 用 paramiko 执行远程命令/传文件（Windows 自带 ssh 拒绝从管道读密码，故需要它） |
| `qqdeploy.py` | **部署脚本**（服务器上装为 `/usr/local/bin/qqdeploy`）：从 GitHub 拉分支 → 校验 → 重建 → 健康检查 → 失败自动回滚。见「协作流程」 |
| `setup-deploy-access.sh` | 安装可信部署工具及受限校验账户；显式指定协作者与公钥，不新增 Docker 组授权 |
| `retire-legacy-compose.sh` | 核对 qqdeploy 已接管及实际挂载后安全退役旧入口，不自动迁移数据或重启容器 |
| `README-部署.md` | **协作者部署说明的源文件**（服务器 `~/README-部署.md` 由它生成；服务器 IP 用占位符，避免入仓泄露） |
| `selfcheck-qqdeploy.py` | qqdeploy 的语法、危险解包及检查器调用静态自查，不代替行为测试 |
| `test-qqdeploy.py` | 使用临时目录和 mock 验证部署、恢复、插件基线与权限边界 |
| `test-headless-smoke.mjs` | 安装应用依赖后运行；隔离源码与数据，使用本地模拟 OneBot 验证无头启动及 HTTP 接口 |
| `test-linux-ops.py` | Linux 上隔离验证退役、守护状态、令牌兼容与运维包生成，不调用真实 Docker |
| `test-runtime-regressions.mjs` | 验证真实 @ 标记、插件失败重载、ZIP 限额/目录及备注删除 |
| `test-prepare-repo.py` | 验证 README 保护、输出目录边界与协作文档保留 |
| `export-config-template.py` | 把运行中的配置导出成脱敏模板（`deploy/config.example.json` 就是这么来的） |

### ⚠️ 改 README 请改模板，不要改 `README.md`

本仓库的 `README.md` 是**生成物**：

```
tools/repo-readme.md   ──(python tools/prepare-repo.py)──▶   README.md
      ↑ 这才是源文件                                              ↑ 会被覆盖
```

直接编辑 `README.md`（包括在 GitHub 网页上编辑）会触发覆盖保护；应把改动同步到源模板。

为防这类误操作，`prepare-repo.py` 在覆盖前会做**三层守卫**，任意一层判定"有未同步的
手工改动"就**保留原 README，继续生成其余产物并以非零状态退出**，并打印差异与两种处理办法：

| 层 | 检查 | 能抓到什么 |
|---|---|---|
| 1 | 正文哈希与生成指纹比较 | 直接改了 README，即使模板也同时更新仍保护原文 |
| 2 | 无指纹时比较 Git 工作区与提交内容 | 旧生成物中未同步到模板的修改 |
| 3 | 无法证明来源且正文不同 | 保留旧手写文件，显式确认后才可强制覆盖 |

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

输出四态，写进 `/opt/qq/napcat-status.txt`，并在**状态发生变化时**往 journald 写 `[NAPWARN]`：

| 状态 | 含义 |
|---|---|
| `OK` | 容器在跑、端口在听、账号已登录 |
| `KICKED` | 被腾讯踢下线，NapCat 停在二维码页，**需要人工扫码** |
| `DOWN` | 容器或端口异常（NapCat 通常会自动重启） |
| `UNKNOWN` | 登录查询失败或证据不足；不能视为已登录，需要检查 WebUI 及凭据 |

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
> `EnvironmentFile=/opt/qq/.env` 注入 `WEBUI_TOKEN`（兼容旧的 `NAPCAT_WEBUI_TOKEN`）。
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
    任一不一致就保护原 README 并打印差异。见 `guard_generated_readme()`。
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
