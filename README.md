# TCC – Team Code Companion

Your front end + a small Node/Express backend that stores the team's memory
(reviews, accepted/rejected fixes, muted rules, custom standards) on the server,
so every teammate shares it. The browser still keeps a local copy as an offline fallback.

## Run locally
    npm install
    npm start          # http://localhost:3000
    npm test           # optional smoke test

## Host it
- **Any VPS / Node host (Render, Railway, Fly, Heroku-style):** build `npm install`, start `npm start`.
  The platform's `PORT` is picked up automatically.
  **Important:** mount a persistent disk and set `DATA_DIR` to it, otherwise data resets on redeploy.
- **Docker:** `docker build -t tcc . && docker run -p 3000:3000 -v tcc-data:/data tcc`

## Config (env vars)
| Var | Default | Purpose |
|---|---|---|
| PORT | 3000 | HTTP port |
| DATA_DIR | ./data | Where state.json is stored |
| BASIC_AUTH_USER / BASIC_AUTH_PASS | off | Set both to password-protect the site |
| RATE_LIMIT_PER_MIN | 300 | API requests per IP per minute |

## API
- `GET /api/health`
- `GET /api/state` → `{exists, rev, state}`
- `PUT /api/state` (JSON, validated & sanitised, 5 MB max)
- `DELETE /api/state`

Note: state is shared by everyone using the site and the last save wins.
Put it behind HTTPS (your host normally does) when using Basic auth.
