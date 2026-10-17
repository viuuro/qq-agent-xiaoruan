# 编码规范

本文适用于本仓库的代码、脚本和配置修改。贡献流程与常用命令见 [仓库贡献指南](AGENTS.md)。约定以现有项目结构为基础；如需引入新工具或调整架构，请在 PR 中说明理由和迁移影响。

## 一、修改范围与协作原则

- 开始前检查工作区和目标文件，保留其他贡献者的修改，不使用整目录覆盖或批量还原清理他人工作。
- 一个 PR 聚焦一个问题；功能修改、格式调整、依赖升级与上游同步尽量拆分，便于审查和回滚。
- 公共接口、配置字段或共享模块发生变化时，检查所有调用方，并在 PR 中说明兼容性影响。
- 合并冲突按双方改动意图解决；不确定的行为先与相关贡献者确认，不直接选择整份文件覆盖。

## 二、文件与命名

| 对象 | 约定 | 示例 |
| --- | --- | --- |
| 普通源码、工具文件 | 优先使用有意义的 kebab-case | `safe-fetch.js`、`check-modules.py` |
| JavaScript 函数、变量 | camelCase | `resolveWithChatWindow` |
| JavaScript 类 | PascalCase | `ChatStore` |
| JavaScript 固定常量 | UPPER_SNAKE_CASE | `DEFAULT_CONFIG` |
| Python 函数、变量 | snake_case | `strip_comments` |
| 测试脚本 | `tools/test-*.mjs` | `test-window-timing.mjs` |

保留现有配置键和对外字段的命名，避免仅为统一风格改名。前端编号脚本属于既有加载约定，不按普通文件规则重命名。

文本使用 UTF-8，遵循 `.gitattributes`：普通文本使用 LF，`.bat`、`.cmd` 使用 CRLF；批处理脚本保持 ASCII，避免 Windows 编码兼容问题。

## 三、JavaScript 后端

- 使用两空格缩进、分号和单引号；插值使用模板字符串。优先使用 `const`，确实需要重新赋值时使用 `let`。
- 使用 ES modules；Node.js 内置模块使用 `node:` 前缀，相对导入写明 `.js` 扩展名。
- 新逻辑放入职责明确的模块，避免持续扩张 `app.js` 或引入循环依赖；路由沿用 `createRoutes(deps)` 的依赖注入方式。
- 将窗口判定、概率计算等业务规则尽量写成纯函数，允许传入时间和随机值，便于确定性测试。
- 异步操作使用 `async`/`await`；明确处理失败、超时和资源释放。允许降级的异常须说明原因并提供必要日志，避免无说明地吞掉异常。
- 注释解释业务约束和设计原因；导出接口或复杂参数可使用 JSDoc，避免逐行复述代码。

```js
import { resolveWithChatWindow } from './prompt.js';

export function shouldReply(options) {
  const result = resolveWithChatWindow(options);
  return result.shouldRespond;
}
```

## 四、前端与界面

- 沿用原生 HTML/CSS/JavaScript，不为局部改动引入框架或构建链。
- `app/ui/app/*.js` 是共享全局词法绑定的普通脚本，保持 `index.html` 中的加载顺序；`app/ui/app.js` 负责 ESM 桥接，新增共享名称前检查冲突。
- 复用现有样式变量、组件和交互方式；提示、确认及输入弹窗优先使用 `showAppAlert`、`uiConfirm`、`uiPrompt`。
- 用户或模型内容优先通过 `textContent` 写入；确需拼接 HTML 时使用现有转义方法，不直接插入不可信字符串。
- 为异步交互处理加载、失败和重复点击；手动验证相关页签、设置保存、弹窗关闭及键盘焦点。

## 五、Python 与运维脚本

- Python 使用四空格缩进，按现有风格组织导入和函数；文本读写明确指定 UTF-8。
- 路径通过 `pathlib` 或 `os.path` 组合；工具新增参数应写明用途、默认值与示例，避免依赖个人绝对路径。
- 写文件、生成目录或清理内容前校验目标范围；保留 `.git` 和必要协作文档。生成工具应在覆盖前检查手工改动。
- 运维脚本从环境变量或未入库的 `.env` 读取凭据；配置示例只放占位值。

## 六、安全与兼容性

- 配置沿用 `app/src/config.js` 的默认值和读写入口；新增字段应兼容已有配置，避免要求贡献者提供真实运行数据。
- 联网抓取复用 `safe-fetch.js` 等现有安全入口，保留 SSRF 检查、白名单、发送限频及会话隔离。
- 日志、测试、截图和 PR 描述不得包含密钥、真实聊天记录或登录凭据；测试账号使用占位值。
- Docker 调整保留持久化挂载及控制台、WebUI 的回环地址绑定；保留上游版权声明，第三方插件再分发前确认许可。

## 七、验证与交付

当前没有配置统一格式化工具、lint 命令或覆盖率阈值，不要把未配置的检查写成已通过。按改动范围执行：

```sh
node --check app/src/prompt.js
python tools/check-modules.py app/src
node tools/test-chat-window-v5.mjs
node tools/test-window-timing.mjs
git diff --check
```

语法检查中的文件替换为实际修改的 JavaScript 文件。窗口回归脚本可直接在仓库执行，详见 [开发与验证](AGENTS.md#开发与验证)。业务变更补充边界及失败场景；窗口相关改动覆盖召唤、续期、过期和概率边界，不依赖真实 QQ、网络或系统时间。部署和生成器测试使用 mock 与独立临时目录，不操作真实 Docker、账号授权或运行数据。

PR 中列出实际执行的命令、结果、未执行项及原因。界面变更提供截图与手动验证结果；文档变更检查链接和命令是否与当前仓库一致。
