# Changelog

## 0.2.0

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
