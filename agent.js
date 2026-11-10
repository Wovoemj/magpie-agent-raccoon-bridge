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
  name: 'Raccoon · Magpie Bridge',
  // Inline so Magpie shows the mark without resolving a file path.
  icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABq0lEQVR4nO2bTU7DMBSEx6McgzWwQIgFJ+JgnIhFhbIgrLkHiEUkK0od/8f29Nu1ssczz89J2qrADW1MzKT7x5dfNMj31yU4j+k9dGoxOGL4EM8mh0jP3cDRwx9lYeiEXrmWiRCHCrvvysajAaOxzUiIQ4hDpfbfy0qIQ4hDiEOIQ4hDiMNSwvPnR9N6Kybnc8A1k0/Pr01p2t8RmNQC+O5MjOGS2kkFmBPa0cdsaf2oAswRu5Hz3MbouooR1QGzY2HXYqV2NNaPXQDmMtMSIT5N7EXQrn6pcx2qGxI8qgNa7oZYPzxj0dyk+DA5HoT+29D3YpWzrY/WLXoEbHxNnDXOxYSCrDsZY3Sdk6JR/bNA6pW5ll72I7BlNZnLbG694h3QA0U7oCcIcQhxCHGm2gsub3eHYx7efzBkBywe4UPGdVWAJTBUrSIQ4hDiEOKw1kKhV/ZadwKiIr6hat4GJ1SmZjgfCHEIcZjyZ4NesbMS4hDi0H6hcAy2GXk0YCT2shHicO/NEbvgWiaGTugRVxbjI9DrbwY+m8hcQq3h69nEiLfaET1u1A2czB9T0stQ5jPAYAAAAABJRU5ErkJggg==',
  // Where Magpie writes the object connect() returns. plugin.js watches it.
  config: '~/.config/magpie-raccoon-bridge/connection.json',
  format: 'json',
  model: 'model',
  ua: ['raccoon-magpie-bridge'],
  notice:
    'Turn this on to put the Magpie model into the Raccoon model menu. Your Raccoon login and ' +
    'account are not affected. The first takeover takes a few seconds; then reopen the model ' +
    'dropdown once to see it. The daily check-in that claims your Raccoon credits runs at 09:00 ' +
    'Beijing time by default, whether this switch is on or off; change it with ' +
    '"raccoon-magpie.js checkin at HH:MM".',
};

export function connect({ gateway, model, models } = {}) {
  const gw = typeof gateway === 'string' ? gateway : gateway?.v1 || gateway?.url;
  const key = typeof gateway === 'object' ? gateway?.key : undefined;
  return {
    enabled: true,
    gateway: gw,
    key,
    model: model || undefined,
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
