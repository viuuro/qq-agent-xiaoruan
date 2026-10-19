# 部署说明（Linux 协作者）

管理员为你配置独立账户及 SSH 公钥。示例账户为 `dev`：

```bash
ssh -i ~/.ssh/id_ed25519 dev@<服务器IP>
```

首次连接先向管理员核对 host key 指纹。不要共享 root 密码，也不要直接使用 Docker socket；此前已有 Docker 组权限的账户需由管理员单独审计。

## 日常部署

```bash
sudo qqdeploy --dry-run main
sudo qqdeploy main
sudo qqdeploy --status
sudo qqdeploy --list
```

也可部署管理员允许仓库中的分支或提交 SHA。自己的 GitHub fork 分支不一定在部署源仓库中，先确认 PR 目标及管理员配置的仓库。

部署源由管理员维护 `/etc/qqdeploy/repositories.json`，默认指向 `viuuro/qq-agent-xiaoruan`。仓库授权变化需要管理员审核，不能通过临时环境变量切换到任意仓库。

部署器会固定完整 SHA、校验代码、构建该版本镜像，然后切换并检查容器、OneBot 和原有启用插件。演练只准备与构建，不切换线上容器。构建与恢复期间有独占锁，看到其他人正在部署时等待，不绕过锁。

## 回滚与故障

```bash
sudo qqdeploy --rollback
sudo qqdeploy --rollback <完整或唯一前缀SHA>
```

目标必须是仍保留的受管理 release。失败时工具尝试恢复原版本，并检查恢复是否成功；恢复失败会明确退出并保留诊断记录，不能仅凭一行“已切回”判断服务恢复。

`--status` 会核对部署记录与实际状态。若出现版本不一致、没有可回退基线或健康检查持续失败，应交给管理员处理；不要手改软链或清空数据目录。

## 查看日志与重启 NapCat

```bash
sudo qqdeploy --logs qq-agent
sudo qqdeploy --logs napcat
sudo qqdeploy --restart-napcat
```

入口只允许上述固定容器。NapCat 重启会断开 QQ，执行前与其他协作者协调。不要使用旧 Compose 重建机器人，也不要在共享环境执行 `down`、`--remove-orphans`。

账号掉线时可通过 SSH 隧道访问管理员配置的实时二维码服务：

```bash
ssh -N -L 6098:127.0.0.1:6098 dev@<服务器IP>
```

浏览器打开 `http://127.0.0.1:6098/`。守护状态 `UNKNOWN` 表示查询失败或证据不足，不代表账号已登录。

## 服务器目录

| 路径 | 用途 |
|---|---|
| `/usr/local/bin/qqdeploy` | 管理员安装的可信部署入口 |
| `/usr/local/lib/qqdeploy/` | 可信校验器、构建及 Compose 模板 |
| `/opt/qq/releases/<sha>/` | 版本源码；不要手改 |
| `/opt/qq/current` | 当前版本软链 |
| `/opt/qq/.deployed.json` | 部署与操作记录 |
| `/opt/qq/qq-agent-data/` | 已核对的应用数据挂载 |
| `/opt/qq/qq-agent-plugins/` | 已核对的插件挂载 |
| `/opt/qq/napcat/` | NapCat 配置及登录态，实际路径以挂载检查为准 |
| `/opt/qq/.env` | 服务器凭据，禁止入库或截图传播 |
| `/opt/qq/docker-compose.napcat.yml` | 管理员维护的 NapCat 入口 |

版本默认保留最近 8 个，当前和上一个版本不随普通清理删除。

## 管理员首次接管与入口退役

退役脚本不负责数据迁移。管理员先核对容器实际挂载、网络、UID/GID 和现有部署记录；从旧 Compose 迁入时先备份，维护窗口内迁移有变化的数据，保留原目录并建立可回退基线。

确认 qqdeploy 已使用原有数据且健康后，再执行 `tools/retire-legacy-compose.sh`。未满足前置条件时脚本会拒绝；既有配置与归档应保留。已经由 qqdeploy 管理的服务器无需再次搬运数据。

本文件由安装器从仓库源文件复制到协作者家目录。修改部署说明应改此源文件，再由管理员更新安装，避免维护两份独立内容。
