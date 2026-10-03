# Working on this repository

- Scope: this repository, its systemd unit, its nginx/Caddy site, and the Hermes profile `alexa`.
  Never use, read or change any other Hermes profile, Hermes instance or application on the server,
  even when one is reachable on localhost. If a task seems to need one, stop and ask the owner.
- The owner reads Indonesian: answer in Indonesian. Code, comments and commit messages are English.
- Before pushing: `npm test` must pass. Security code (`src/verify.js`, the tool check in `src/hermes.js`)
  changes only with a test that fails without the change.
- Never commit `.env` or any key. Never set `ALEXA_SKIP_VERIFICATION=true` on the server.
- On the server, run `nginx -t` before every nginx reload, and touch only this service's own site file.
