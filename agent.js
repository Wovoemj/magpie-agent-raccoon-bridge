/**
 * Magpie agent entry (`magpie.agent`).
 *
 * Magpie evaluates THIS file in a small sandbox: no Node APIs, no imports beyond
 * files beside it. So it stays pure data — the descriptor plus a `connect()` that
 * answers immediately. Everything else (rewriting the Raccoon model menu, keeping
 * the catalog in step with Magpie) happens in `plugin.js`, which the OpenCode host
 * loads with full Node access.
 */

export const agent = {
  id: 'raccoon-bridge',
  name: '小浣熊 · Magpie 桥接',
  // Inline so Magpie shows the mark without resolving a file path.
  icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABq0lEQVR4nO2bTU7DMBSEx6McgzWwQIgFJ+JgnIhFhbIgrLkHiEUkK0od/8f29Nu1ssczz89J2qrADW1MzKT7x5dfNMj31yU4j+k9dGoxOGL4EM8mh0jP3cDRwx9lYeiEXrmWiRCHCrvvysajAaOxzUiIQ4hDpfbfy0qIQ4hDiEOIQ4hDiMNSwvPnR9N6Kybnc8A1k0/Pr01p2t8RmNQC+O5MjOGS2kkFmBPa0cdsaf2oAswRu5Hz3MbouooR1QGzY2HXYqV2NNaPXQDmMtMSIT5N7EXQrn6pcx2qGxI8qgNa7oZYPzxj0dyk+DA5HoT+29D3YpWzrY/WLXoEbHxNnDXOxYSCrDsZY3Sdk6JR/bNA6pW5ll72I7BlNZnLbG694h3QA0U7oCcIcQhxCHGm2gsub3eHYx7efzBkBywe4UPGdVWAJTBUrSIQ4hDiEOKw1kKhV/ZadwKiIr6hat4GJ1SmZjgfCHEIcZjyZ4NesbMS4hDi0H6hcAy2GXk0YCT2shHicO/NEbvgWiaGTugRVxbjI9DrbwY+m8hcQq3h69nEiLfaET1u1A2czB9T0stQ5jPAYAAAAABJRU5ErkJggg==',
  // Where Magpie writes the object connect() returns. plugin.js watches it.
  config: '~/.config/magpie-raccoon-bridge/connection.json',
  format: 'json',
  model: 'model',
  ua: ['raccoon-magpie-bridge'],
  notice:
    '打开开关即可把 Magpie 选中的模型写进小浣熊的模型菜单，小浣熊自身的登录与账号不受影响。' +
    '在 Magpie 里换模型是替换这一条，不会把整个目录塞进菜单。' +
    '首次连接后重新打开模型下拉框即可看到，网关异常会在桥接状态中明确显示。' +
    '每日签到默认在北京时间 09:00 自动领取小浣熊积分，与这个开关是否打开无关；' +
    '改时间请执行 raccoon-magpie.js checkin at HH:MM。',
};

export function connect({ gateway, model, models } = {}) {
  const gw = typeof gateway === 'string' ? gateway : gateway?.v1 || gateway?.url;
  const key = typeof gateway === 'object' ? gateway?.key : undefined;
  return {
    enabled: true,
    gateway: gw,
    key,
    model: (typeof model === 'string' ? model : model?.id) || undefined,
    models: (models || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context || null,
    })),
  };
}

export function disconnect() {
  return { enabled: false };
}

export default agent;
