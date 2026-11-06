# SSH 服务器管理插件（DSH）

DeepSeek Harness（DSH）桌面端 / Web 端的持久化插件。在 **设置 → SSH 服务器** 中集中管理 Linux 服务器的
SSH 连接信息（支持多台、新增、编辑、删除、测试连通性），并让智能体能够识别这些服务器、通过 SSH 远程执行命令
获取服务器信息。

- 包名：`@local/dsh-ssh-manager`
- 版本：`1.0.0`
- 依赖：`ssh2`（纯 JavaScript SSH 客户端，已随插件目录安装）

## 功能

| 能力 | 说明 |
| --- | --- |
| 多服务器管理 | 新增、编辑、删除任意数量的服务器；名称为空时自动使用 `用户名@主机` |
| 两种认证方式 | 密码认证，或私钥认证（支持带 passphrase 的私钥） |
| 连接测试 | 列表内逐台测试；编辑弹窗内可在保存前测试当前填写的配置 |
| 智能体识别 | 每轮对话的系统提示自动列出已配置服务器（不包含任何密码/私钥） |
| 远程命令 | 智能体通过 `ssh_exec` 工具执行远端命令，返回 stdout / stderr / 退出码 |
| 服务器列表工具 | 智能体通过 `ssh_servers` 工具查看服务器清单、测试连通性 |
| `@` 快捷引用 | 在对话输入框输入 `@`，菜单中出现 **SSH** 分组，列出已添加的服务器；选中后插入 `@服务器名` |
| 数据持久化 | 配置保存在当前 profile 的 `data/ssh-manager/servers.json`，原子写入 |

## 使用

1. 打开 **设置**（左下角齿轮）→ 左侧导航 **SSH 服务器**。
2. 点击 **添加服务器**，填写：
   - 名称（可选，便于智能体引用）
   - 主机 / IP、端口（默认 22）、用户名
   - 认证方式：密码 或 私钥（私钥支持 passphrase）
   - 备注（可选）
3. 保存后可点击列表中的 **测试** 验证连通性（远端返回 `uname` 信息）。
4. 直接对智能体说：“列出 SSH 服务器”“在 web-01 上执行 `df -h`”，智能体会调用 `ssh_servers` / `ssh_exec`。
5. 也可以在输入框输入 `@` → 在 **SSH** 分组中选一台服务器，会插入 `@服务器名`；发送后智能体按该名称执行命令。

编辑时密码/私钥输入框留空表示保持原有凭据不变。

## 智能体工具

### `ssh_servers`
- `action: "list"`：列出已配置服务器（仅名称、地址、用户、认证方式，不含凭据）。
- `action: "test"` + `server`：测试指定服务器连通性。

### `ssh_exec`
- `server`：服务器 id 或名称（来自 `ssh_servers` / 系统提示中的列表）。
- `command`：远端 shell 命令。
- `timeout_seconds`：超时（1–600，默认 60）。

返回：`exitCode`、`stdout`、`stderr`、`durationMs`、`truncated`。

> 远程命令会以当前 SSH 用户在目标服务器上执行。请只配置可信服务器，并注意会话记录会保存工具调用参数
> （命令文本会进入会话记录；密码/私钥不会出现在工具参数中）。

## 配置与数据位置

按优先级解析数据目录：

1. `DSH_PROFILE_DIR` → `<profile>/data/ssh-manager`
2. `DSH_HOME` → `<home>/ssh-manager`
3. `~/.dsh/ssh-manager`

`servers.json` 包含密码 / 私钥明文（与 DSH 自身的凭据文件同级保护），POSIX 下写入时尽力设置为 `600`。
请勿把该文件提交到版本库或分享给他人。

## 安全说明

- 凭据只保存在主机侧，浏览器端与智能体只能看到“是否已配置凭据”的布尔值。
- SSH 主机密钥采用“接受”策略（与常见的运维工具一致），适用于内网/可信机房；如需严格校验请在后续版本中
  扩展 known_hosts 支持。
- 删除服务器会同时删除其保存的密码/私钥。

## 安装 / 卸载

**推荐：一键安装（无需克隆源码、无需手动安装依赖）**

在 DSH 中打开 **插件** 页面 → **安装插件**，在安装输入框中填写下面任一 spec：

```text
github:xymkis/dsh-ssh-manager
https://github.com/xymkis/dsh-ssh-manager
```

插件管理器会拉取仓库并**自动安装 `ssh2` 依赖**（`ssh2` 为纯 JavaScript 实现，无需编译；可选的
`cpu-features` 原生构建会被跳过，不影响使用）。安装完成后 bundle 自动挂载，无需手改任何配置文件。

若使用 DSH CLI：

```powershell
dsh plugin add github:xymkis/dsh-ssh-manager
```

**本地开发安装（link 模式，改代码即时生效）**

```powershell
git clone https://github.com/xymkis/dsh-ssh-manager.git D:\dsh-plugins\dsh-ssh-manager
cd D:\dsh-plugins\dsh-ssh-manager
npm install --omit=dev --ignore-scripts   # 安装 ssh2 运行期依赖（node_modules 不随仓库提交）
```

然后用 DSH 插件管理器以**该目录的绝对路径**安装为本地 bundle：

```text
plugin_manager install_bundle  target = <克隆目录的绝对路径>
```

安装器会把它写成当前 profile 的 `link:` 依赖（`@local/dsh-ssh-manager → link:<克隆目录>`），所以：

- 安装后**不要移动或删除该目录**，否则下次启动会加载失败；移动后重新执行一次安装即可。
- `npm install --ignore-scripts` 会跳过可选的 `cpu-features` 原生构建，`ssh2` 仍可用纯 JS 实现。

卸载：在插件管理器中移除该 bundle（或在 profile 的 `cordis.patch.yml` 中禁用 `ssh-manager` 行）。

## 开发 / 验证

以下脚本都不需要启动 DSH，全部离线运行：

| 脚本 | 内容 |
| --- | --- |
| `node scripts/smoke-host.mjs` | store CRUD/校验/冲突/损坏文件隔离、伪 ctx 注册、HTTP 信封与信任拦截、工具输出、提示段、卸载清理 |
| `node verify/preflight.mjs` | Lead 侧集成预检：真实路由 + 工具 + 提示段 + 数据落盘 + 浏览器侧模块装载/槽位注册，并断言任何响应不含凭据 |
| `node verify/ssh-e2e.mjs` | 在本机拉起一次性 ssh2 服务端，验证密码认证、RSA 私钥认证、exec stdout/退出码、probe、错误映射与超时 |
| `node verify/echo-ssh-server.mjs` | 手动联调用的临时 SSH 服务端（打印端口），可配合 UI 的“添加服务器”测试 |
| `npm test` | 依次执行前三个脚本 |

安装后的快速自检：对智能体说“列出 SSH 服务器”，应调用 `ssh_servers` 并返回已配置列表（或空列表提示）。

## 目录结构

```
dsh-ssh-manager/          # 克隆后的仓库根目录
├── index.js            # 主机侧入口（apply / inject）
├── client.js           # 浏览器侧设置页（单文件、无构建）
├── host/
│   ├── store.js        # 服务器记录校验与持久化
│   ├── ssh.js          # ssh2 连接、执行、探测
│   ├── api.js          # /ssh-manager/api/* JSON 路由
│   ├── tools.js        # ssh_servers / ssh_exec 智能体工具
│   └── prompt.js       # 系统提示中的服务器清单
├── cordis.patch.yml    # bundle 插件行
├── locale/             # 插件管理器的标题/描述
├── icon.svg
├── scripts/smoke-host.mjs  # 主机侧离线冒烟测试
└── verify/                 # Lead 侧集成预检与本地 SSH 联调脚本
```

