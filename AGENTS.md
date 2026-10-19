# 仓库贡献指南（Repository Guidelines）

## 项目结构

- `app/src/`：Node.js 后端，包含 OneBot 接入、消息编排、提示词、存储；`skills/` 子目录负责扩展基础设施。
- `app/ui/`：原生 HTML/CSS/JavaScript 控制台；`app/` 子目录中的编号脚本按 `index.html` 声明顺序执行。
- `app/assets/`：图标；根目录 `persona-*.md`：角色卡示例。
- `tools/`：Python 维护工具与 Node.js 回归测试。
- `deploy/`：Docker 配置、运维脚本及 systemd 单元。

## 开发与验证

需要 Node.js 20+、Python 3。以下命令均从仓库根目录执行：

```sh
npm install --prefix app                      # 安装应用依赖
node app/src/server.js                        # 启动无头控制台
python tools/check-modules.py app/src          # 检查模块导入与导出
node tools/test-chat-window-v5.mjs             # 窗口响应概率回归
node tools/test-window-timing.mjs              # 窗口计时回归
node tools/test-runtime-regressions.mjs        # @、插件、ZIP、备注回归
node tools/test-headless-smoke.mjs             # 隔离启动及模拟 OneBot 检查（需先装依赖）
python3 tools/test-prepare-repo.py             # 生成器文件保护
python3 tools/test-qqdeploy.py                 # 模拟部署与失败恢复
python3 tools/test-linux-ops.py                # Linux 隔离运维测试
docker build -f deploy/Dockerfile -t qq-agent:local .
docker compose -f deploy/docker-compose.yml up -d
```

控制台默认地址为 `http://127.0.0.1:3210`，模型和 OneBot 在控制台配置。`app/package.json` 未定义 npm scripts，不要照搬上游 README 中的 `npm test` 等命令。

窗口测试会自动定位 `app/src/prompt.js` 或开发环境的 `resources/app/src/prompt.js`，独立克隆可直接运行。测试采用自定义断言，没有配置覆盖率门槛；新增用例放在 `tools/test-*.mjs`，使用假时钟和可控随机值。Python 回归脚本使用标准库 unittest，运行 `python -X utf8 tools/test-prepare-repo.py` 等对应检查。后端改动检查模块依赖，界面改动手动验证相关操作。

## 编码规范

贡献者及自动化代理均应遵循 [编码规范](CODING_STANDARDS.md)，其中规定缩进、命名、模块边界、错误处理、安全要求与验证方式。以相邻代码风格为准，避免在功能 PR 中混入全文件格式化。

## Fork 与多人协作

- `origin` 指向自己的 GitHub fork；`upstream` 指向此次 PR 的目标协作仓库，先用 `git remote -v` 核实，不要把应用原作者仓库与目标协作仓库混淆。
- 从目标仓库最新默认分支创建工作分支，完成后推送到自己的 fork，再向约定的目标仓库及分支提交 PR。共享分支不强制推送、不重写他人历史。
- 修改前检查 `git status` 和差异，保留他人未提交改动；多人涉及同一模块时先协调职责。
- 提交格式参考 `feat(window): 修正窗口概率`、`fix(prompt): 修复提示词重复`、`docs: 更新协作指南`，一次提交聚焦一个目的。
- PR 写明问题、行为变化、验证结果及已知失败；有关联 Issue 时附链接，界面变化附截图。上游同步与功能修改尽量分开提交。

## 文档与配置安全

根目录 `README.md` 是生成物，内容修改应落在 `tools/repo-readme.md`。生成工具依赖外部 `resources/app/` 源目录，执行前检查输入、输出和清理范围，避免覆盖协作文档。

当前目标为 Linux 无头服务器，桌面启动依赖暂不处理。禁止提交 API Key、`.env`、聊天记录、登录态及运行配置；保留数据、插件和 NapCat 状态挂载，以及上游 MIT 声明。上线使用管理员安装的可信 qqdeploy；不通过协作者 Docker 组授权或执行分支脚本获取宿主权限。首次接管先核实实际挂载、备份并建立可回退基线，确认健康后才退役旧入口。详见 [部署说明](tools/README-部署.md)。
