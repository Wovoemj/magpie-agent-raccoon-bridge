# Raccoon · Magpie Bridge

Make **商汤小浣熊** (SenseTime Raccoon, `@raccoonoffice-desktop`) use every model and
routing group configured in Magpie. The model menu returns the Magpie catalog;
Raccoon's own login, account and credits are left untouched.

Built on the same idea as [`magpie-agent-cursor-bridge`](https://github.com/932633145/magpie-agent-cursor-bridge)
and `magpie-agent-trae-bridge`, but adapted to how Raccoon actually resolves models.

---

## Why this is not a proxy bridge

Cursor and Trae need a local TLS proxy because their model traffic is pinned to a
vendor endpoint. Raccoon does not:

- its model menu is driven by a saved list of **model presets**, each carrying its
  own `remoteBaseUrl` / `remoteApiKey` / `remoteModelId`;
- selecting a preset sends `POST ${remoteBaseUrl}/chat/completions` with
  `Authorization: Bearer ${remoteApiKey}`.

That is a native bring-your-own-endpoint path. Magpie already serves an
OpenAI-compatible gateway, so the honest integration is to **write Magpie's models
into that preset list** — no certificate, no proxy, no patched `app.asar`.

```
Magpie agent plugin → writes connection.json (gateway, key, picked model)
                                ↓
                     hidden watcher (this bridge)
                     ├─ probes GET /v1/models on the gateway
                     ├─ rewrites Raccoon's model presets
                     └─ restores them byte-exactly on disconnect
                                ↓
Raccoon model menu ──[per-preset endpoint]──> Magpie gateway ──> providers
```

What is written, and what is not:

| File | Treatment |
| :--- | :--- |
| `%USERPROFILE%\.office-raccoon\agent\config\config.yaml` | rewritten in place, only the owned scalars |
| `%USERPROFILE%\.office-raccoon\agent\config\auth.json` | **never written**, never read for tokens |

---

## Features

- **One entry, not a dump**: the menu carries the single model Magpie is set to,
  under the label Magpie gives it. Switching models in Magpie replaces that entry
  instead of piling up the whole catalog.
- **Per-model limits**: `context_window` / `max_output_tokens` are copied from the
  gateway, so Raccoon's own context accounting stays honest.
- **Two-way respect**: a model you pick in Raccoon is never overwritten by a later
  sync; a model you pick in Magpie takes the main model back.
- **Deletions stick**: a Magpie entry you remove from the menu stays removed.
- **Byte-exact undo**: disconnect restores the original file, unless you have since
  changed models — then your newer choice is kept and only the Magpie entry goes.
- **No-op friendly**: an unchanged catalog does not rewrite the file at all.
- **Daily check-in**: claims Raccoon's daily credits at 09:00 Beijing time, and
  reports what actually landed rather than what the request returned.

---

## Daily check-in

Raccoon has no dedicated check-in endpoint: loading
`/api/web/office/v3/setting_info` with the account token is what triggers the
daily grant. A check-in therefore snapshots today's grant bills, touches that
endpoint, then diffs the bills again.

That diff is the point. Reporting the HTTP status would mean claiming `+300`
on every run and calling a silent failure a success; the diff reports `claimed`
only when new grant bills appeared, and `already checked in today` otherwise.

- The schedule is evaluated in **Beijing time**, because that is where the vendor
  cuts the day. A laptop in another timezone still checks in once per Beijing day.
- A failed attempt leaves the day **pending**, so the next pass retries instead of
  silently losing the day's credits. A refused sign-in waits for you instead.
- It runs whether or not the model switch is on: the credits are the account's,
  not the bridge's.

```bash
node bin/raccoon-magpie.js checkin          # show the schedule and the last result
node bin/raccoon-magpie.js checkin at 07:30 # set the time (Beijing), switching it on
node bin/raccoon-magpie.js checkin on        # switch it on
node bin/raccoon-magpie.js checkin off       # switch it off
node bin/raccoon-magpie.js checkin now       # claim now, ignoring the schedule
```

The schedule is set from the CLI because Magpie's agent descriptor has no writable
field for it; a field declared there would be ignorable, which is worse than not
declaring one.

State lives in `~/.config/magpie-raccoon-bridge/checkin.json`. The token is read
from Raccoon's own `auth.json` and never refreshed or written by this bridge.

---

## Install

Add the repository to Magpie → **Plugins**:

```text
github:Wovoemj/magpie-agent-raccoon-bridge
```

Then open Magpie → **Agents**, switch on **Raccoon · Magpie Bridge**, and pick the
model you want Raccoon to start on.

Finally refresh Raccoon's model dropdown (or open the chat panel once). No restart
of Raccoon is needed for the preset list; the app re-reads it when the menu opens.

### Requirements

- Raccoon desktop client installed and signed in at least once, so that
  `<profile>/agent/config/config.yaml` exists. The bridge refuses to invent that
  file: with nothing to edit it says so instead of writing a config Raccoon would
  then have to be told to trust.
- At least one model or routing group configured in Magpie.

### Install as a folder instead

Magpie also accepts a local path or a packed tarball. That is useful while
developing, but the plugin card will report `npm didn't answer` because the
package is not published — the bridge itself still works.

---

## Commands

```bash
node bin/raccoon-magpie.js status     # what Magpie says, what Raccoon has, what the bridge did
node bin/raccoon-magpie.js doctor     # probe the gateway, list groups, check login
node bin/raccoon-magpie.js sync       # one reconcile pass (--force ignores the cache)
node bin/raccoon-magpie.js apply      # write the catalog without waiting for Magpie
node bin/raccoon-magpie.js restore    # hand Raccoon its own menu back
node bin/raccoon-magpie.js install    # register the hidden watcher at login
node bin/raccoon-magpie.js uninstall  # restore + remove the watcher
```

`watch` is what the login entry runs; it polls Magpie's switch every 5 seconds.

---

## How the main model is chosen

The preset list and the active model are treated separately, on purpose:

1. Magpie has an explicit pick (`connection.model`) → the bridge points the main
   model at it.
2. The active entry is already the Magpie entry → the bridge keeps it selected so
   its limits stay fresh after a catalog change.
3. `use_default_remote_preset` is true → Raccoon is still on its builtin catalog,
   so the bridge takes over.

Your own saved services and Raccoon's builtin models are never rewritten — only the
one Magpie entry is the bridge's to manage.
4. Anything else → you chose it yourself. The bridge refreshes the preset list and
   leaves your model alone.

---

## Troubleshooting

**The plugin card is mostly empty and says `npm didn't answer: not found`.**
The card's source, licence, downloads and README all come from npm, and this
package is distributed from GitHub only. The bridge is unaffected: check the
Agents page for the switch and the model list.

**The Agents page does not list the bridge.**
Magpie logs the reason to `%LOCALAPPDATA%/magpie/logs/app.log`. The usual cause is
a plugin spec that does not resolve, e.g. a relative path, which Magpie resolves
against its own working directory rather than the plugins folder.

**The model menu does not change.**
Turn the switch off and on once. Each toggle makes Magpie rewrite
`connection.json`, which is what wakes the bridge.

## Layout

```text
agent.js              Magpie agent descriptor (pure data, evaluated in a sandbox)
plugin.js             Magpie plugin entry: watches the switch, runs reconcile
bin/raccoon-magpie.js CLI and the hidden `watch` loop
lib/yaml.js           line-based, byte-preserving editor for Raccoon's config
lib/sync.js           preset merge, write, journal, restore
lib/magpie.js         gateway discovery and catalog parsing
lib/supervise.js      connection state and the reconcile pass
lib/autostart.js      login entry (Startup .vbs / LaunchAgent)
test/                 node test/run.mjs
```

---

## License

MIT.
