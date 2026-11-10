# Changelog

## 未发布

### 新增

- **三种登录方式**（对齐官方 provider 插件的做法）：`login`（浏览器，默认）、
  `login manual`（粘贴回调链接 / access_token / JSON）、`login desktop`（沿用客户端登录态）。
  `manual` 是为「授权页要求网页登录态」「回环被拦」「远程主机」这些回环走不通的环境准备的。
- **自动续期。** 登录时一并存下 `refresh_token`，`watch` 每轮检查，临期 5 分钟内静默刷新并写回。
  刷新被服务端拒绝（4xx）时报一次 `needLogin`，不拿失效凭据反复重试。
- **`whoami` / `renew` 命令**：查看登录态、过期时间、是否可续期；手动触发一次续期。

- **浏览器登录。** `raccoon-magpie.js login` 走小浣熊网页版自己的授权流程：`/code/authorize`
  带 `desktop_callback=loopback`，回调到 `127.0.0.1:<随机端口>/auth/callback`，再用授权码
  换令牌。这样**没装小浣熊客户端**的机器也能用——那种情况下 `config.yaml` 还不存在，
  模型菜单本来没有地方可写。`logout` 移除本机登录态。
  - state 为 64 位十六进制，不匹配的回调被拒绝且不会中止正在进行的那次登录
  - 授权码只能换一次，过期（`200035`）明确报「请重新登录」，不当作网络错误重试
  - 令牌写入 `auth.json`，`0600`，只动 `access_token` / `office_identity`，其余键保留

## 0.2.0

### Packaging

- Published to npm as `magpie-agent-raccoon-bridge`, so the plugin card has a
  source, licence and README instead of `npm didn't answer`. `github:` installs
  still work.
- Added `repository` / `homepage` / `bugs`, and a `raccoon-magpie` command.

### Added

- **Daily check-in.** Claims Raccoon's daily credits on a schedule (09:00 Beijing
  by default) and reports what actually landed. Raccoon has no check-in endpoint:
  loading `/api/web/office/v3/setting_info` triggers the grant, so the bridge
  snapshots today's grant bills, touches it, then diffs — `claimed` only when new
  grant bills appeared, `already checked in today` otherwise.
  - evaluated in Beijing time, because that is where the vendor cuts the day
  - a failed attempt keeps the day pending so the next pass retries
  - runs whether or not the model switch is on
  - `node bin/raccoon-magpie.js checkin` claims now, ignoring the schedule
- `checkin_at` option on the agent card, so the time is visible in Magpie.

### Fixed

- The profile directory is chosen by looking for a real `config.yaml` first, so a
  leftover empty `~/.box-agent` from an older build cannot win over the install.
- Config writes are serialised with a lock: Magpie's plugin host and the standalone
  watcher can reconcile at the same time.
- `7:5` is accepted as a schedule time, not just `07:05`.

## 0.1.0

First public version.

- Puts the model Magpie is set to into Raccoon's model menu, as one preset that is
  replaced in place when the Magpie model changes.
- The user's own saved services and Raccoon's builtin models are never rewritten.
- A model picked in Raccoon is not overwritten, and a deleted entry stays deleted.
- `config.yaml` is edited line by line, so untouched lines stay byte-identical.
- Disconnect restores the file byte-exactly.
