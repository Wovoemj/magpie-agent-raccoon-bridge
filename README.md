# 小浣熊 · Magpie 桥

让 **商汤小浣熊**（SenseTime Raccoon，`@raccoonoffice-desktop`）直接使用 Magpie 里配置的模型与路由组。模型菜单里会出现 Magpie 当前选中的模型；小浣熊自身的登录、账号与积分不受影响。

思路与 [`magpie-agent-cursor-bridge`](https://github.com/932633145/magpie-agent-cursor-bridge) 和 `magpie-agent-trae-bridge` 一致，但按小浣熊实际的取模方式来适配。

---

## 为什么这里不需要代理

Cursor 和 Trae 需要本地 TLS 代理，因为它们的模型流量被钉在厂商域名上。小浣熊不是这样：

- 它的模型菜单由一份**模型方案**列表驱动，每条方案自带 `remoteBaseUrl` / `remoteApiKey` / `remoteModelId`；
- 选中某条方案时，客户端发出 `POST ${remoteBaseUrl}/chat/completions`，带上 `Authorization: Bearer ${remoteApiKey}`。

这是一条原生的「自带服务端点」通路。Magpie 本身已是 OpenAI 兼容网关，所以最直接的接法就是**把 Magpie 的模型写进这份方案列表**——不需要证书、不需要代理、也不用改 `app.asar`。

```
Magpie 插件 → 写入 connection.json（网关、key、选中的模型）
                          ↓
                后台同步进程（本插件）
                ├─ 探测网关 GET /v1/models
                ├─ 重写小浣熊的模型方案
                └─ 断开时按字节还原
                          ↓
小浣熊模型菜单 ──[每条方案自己的端点]──> Magpie 网关 ──> 各提供商
```

写入范围：

| 文件 | 处理方式 |
| :--- | :--- |
| `%USERPROFILE%\.office-raccoon\agent\config\config.yaml` | 就地改写，只动它自己的那几个标量 |
| `%USERPROFILE%\.office-raccoon\agent\config\auth.json` | **从不写入**，也不从中读取令牌 |

---

## 功能

- **只放一条，不倾倒目录**：菜单里只有 Magpie 当前选定的那个模型，用 Magpie 给的名称显示。在 Magpie 里换模型是**替换**这一条，而不是越积越多。
- **沿用模型限额**：`context_window` / `max_output_tokens` 取自网关，小浣熊的上下文计算保持真实。
- **双向尊重**：你在小浣熊里选的模型，后续同步不会覆盖；你在 Magpie 里选定后，主模型会切过去。
- **删除会保留**：你在菜单里删掉的 Magpie 条目，不会被下次同步加回来。
- **按字节还原**：断开时恢复原始文件；若你之后自己换过模型，则保留你的新选择，只清掉 Magpie 那一条。
- **无变化不写盘**：模型目录没变时完全不改文件。
- **每日签到**：每天北京时间 09:00 领取小浣熊积分，并如实报告**实际到账**多少，而不是只看请求是否成功。

---

## 每日签到

小浣熊没有专门的签到接口：带账号令牌加载 `/api/web/office/v3/setting_info` 就会触发当日发放。所以一次签到是「先快照今日的发放账单 → 请求该接口 → 再读一次账单做差集」。

这个差集是关键。若只报 HTTP 状态，每次都会声称 `+300`，还会把静默失败当成成功；只有出现**新的发放记录**才报 `claimed`，否则报「今日已签到」。

- 时间按**北京时间**判定，因为厂商在北京零点切日。换个时区的电脑，也仍是每个北京日只签一次。
- 失败时当天**保持待签**，下一轮重试，不会静默丢掉当天积分。登录被拒则等你重新登录，不空转重试。
- 无论模型开关是否打开都会执行：积分是账号的，不是这个桥的。

```bash
node bin/raccoon-magpie.js checkin           # 查看时间设置与上次结果
node bin/raccoon-magpie.js checkin at 07:30  # 设定时间（北京时间），同时开启
node bin/raccoon-magpie.js checkin on        # 开启
node bin/raccoon-magpie.js checkin off       # 关闭
node bin/raccoon-magpie.js checkin now       # 立即签到，忽略时间设置
node bin/raccoon-magpie.js login             # 浏览器登录，写回登录态
node bin/raccoon-magpie.js logout            # 移除本机登录态
```

时间设置走命令行，是因为 Magpie 的 agent 描述符没有可写字段；在那里声明一个字段只会变成一个点了没反应的控件，比不声明更糟。

状态存放在 `~/.config/magpie-raccoon-bridge/checkin.json`。令牌读取小浣熊自己的 `auth.json`，本插件既不会刷新也不会写入它。

---

## 安装

在 Magpie → **插件** 里添加，二选一。

用包名：

```text
magpie-agent-raccoon-bridge
```

或直接用仓库地址：

```text
github:Wovoemj/magpie-agent-raccoon-bridge
```

npm 包与仓库内容一致；用 npm 包名安装时，插件卡片还能拿到源码地址、许可证和说明文档，不会显示 `npm 没有响应`。

然后在 Magpie → **Agents** 打开 **小浣熊 · Magpie 桥** 的开关，并选定要让小浣熊默认使用的模型。

最后刷新一次小浣熊的模型下拉框（或打开一次对话面板）。方案列表不需要重启小浣熊，菜单打开时它会重新读取。

### 前提条件

- `<配置目录>/agent/config/config.yaml` 必须存在。本插件不会凭空创建它：没东西可改时会明说，
  而不是写一份小浣熊还得被说服去信任的配置。这个文件由小浣熊客户端首次登录时生成；
  **没装客户端也可以用浏览器登录来生成**，见下节。
- Magpie 里至少配置了一个模型或路由组。

### 浏览器登录（没装客户端也能用）

```bash
node bin/raccoon-magpie.js login     # 打开浏览器，授权后自动写回登录态
node bin/raccoon-magpie.js logout    # 移除本机登录态
```

走的是小浣熊网页版自己的授权流程：`/code/authorize` 带 `desktop_callback=loopback`，
回调到 `127.0.0.1:<随机端口>/auth/callback`，再用授权码换令牌
（`/api/web/auth/v1/login_with_authorization_code`）。几点是刻意的：

- **state 为 64 位十六进制**，回调必须一字不差地带回；不匹配的回调会被拒绝，
  且**不会中止**正在进行的那次登录——误开的标签页不该毁掉你正在做的事。
- 回调只接受 `Host` 完全等于 `127.0.0.1:<端口>`、路径为 `/auth/callback` 的 GET。
- 授权码只能换一次；厂商回 `200035` 表示码已失效，此时直接报「请重新发起登录」，
  而不是当成网络错误反复重试。
- 令牌写入 `<配置目录>/agent/config/auth.json`，权限 `0600`，只写 `access_token` 与
  `office_identity` 两个字段，文件里原有的其他键（如果有）保持不动。

### 用本地目录安装

Magpie 也接受本地路径或打包好的 tgz。开发时方便，但插件卡片会显示 `npm 没有响应`，因为包里没有 npm 元数据——功能本身不受影响。

---

## 命令

```bash
node bin/raccoon-magpie.js status     # Magpie 的状态、小浣熊的状态、桥做了什么
node bin/raccoon-magpie.js doctor     # 探测网关、列出分组、检查登录
node bin/raccoon-magpie.js sync       # 执行一次同步（--force 忽略缓存）
node bin/raccoon-magpie.js apply      # 不等 Magpie，直接写入目录
node bin/raccoon-magpie.js restore    # 把小浣熊自己的菜单还回去
node bin/raccoon-magpie.js install    # 注册开机自启的后台进程
node bin/raccoon-magpie.js uninstall  # 还原并移除自启
```

开机自启运行的是 `watch`，每 5 秒检查一次 Magpie 的开关。

---

## 主模型是怎么定的

方案列表和「当前主模型」是分开处理的，这是有意为之：

1. Magpie 有明确指定（`connection.model`）→ 主模型指向它。
2. 当前选中的就是 Magpie 那一条 → 继续保持选中，让限额随目录更新。
3. `use_default_remote_preset` 为真 → 小浣熊还在用自己的内置目录，由本插件接管。

你自己保存的服务和小浣熊的内置模型永远不会被改写——只有 Magpie 那一条归本插件管。

4. 其余情况 → 认定是你自己的选择，只刷新方案列表，不动你的模型。

补充一点：小浣熊自己也会在更新后、或某条方案失效时回落到内置模型，这在文件里看起来和「用户手动切换」一模一样。两者靠历史区分：**切回内置模型**只在前两次算你的选择，之后识别为应用重置并收回；**切到你自己保存的服务**则永远尊重。

---

## 常见问题

**插件卡片基本是空的，并显示 `npm 没有响应: not found`。**
卡片上的来源、许可证、下载量和说明文档都来自 npm。改用 npm 包名（`magpie-agent-raccoon-bridge`）安装即可显示；用 `github:` 也能正常工作。

**Agents 页面里找不到这个桥。**
Magpie 会把原因写进 `%LOCALAPPDATA%/magpie/logs/app.log`。最常见的是插件来源无法解析，比如相对路径——Magpie 是相对它自己的工作目录解析的，不是插件目录。

**模型菜单没变化。**
把开关关掉再打开一次。每次切换都会让 Magpie 重写 `connection.json`，那才是唤醒本插件的信号。

---

## 目录结构

```text
agent.js              Magpie 的 agent 描述符（纯数据，在沙箱里求值）
plugin.js             Magpie 插件入口：监听开关、执行同步
bin/raccoon-magpie.js 命令行与后台 watch 循环
lib/yaml.js           逐行编辑小浣熊配置，保留原字节
lib/sync.js           方案合并、写入、日志、还原
lib/magpie.js         网关发现与目录解析
lib/supervise.js      连接状态与同步流程
lib/checkin.js        每日签到
lib/clock.js          北京时间换算
lib/autostart.js      开机自启（启动目录 .vbs / LaunchAgent）
test/                 node test/run.mjs
```

---

## 许可证

MIT。
