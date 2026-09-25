# LELA Multi-Platform Deployment Guide

This project is fully platform-agnostic and can be deployed to **any** cloud hosting platform or VPS without code modifications.

---

## Supported Hosting Platforms

### 1. Render.com
- **Method A (GitHub Blueprint)**: Connect your repo to Render. Render will automatically detect `render.yaml` and create the Web Service.
- **Method B (Manual)**:
  - Create a **Web Service** on Render.
  - Build Command: `npm ci`
  - Start Command: `node server.cjs`
  - Environment Variables: Set `NODE_ENV=production`, `PORT=10000`, `JWT_SECRET=your_secret`.

---

### 2. Docker / AWS / GCP / DigitalOcean / VPS / Coolify / CapRover
- Use the included production `Dockerfile`:
```bash
docker build -t lela-video-chat .
docker run -d -p 3000:3000 --env-file .env lela-video-chat
```
- Listens on `0.0.0.0:${PORT || 3000}`.
- Includes automated container health checks.

---

### 3. Fly.io
- Deploy using the included `fly.toml`:
```bash
fly launch
fly deploy
```

---

### 4. Heroku / Dokku / CapRover
- Uses the included `Procfile`:
```text
web: node server.cjs
```
- Simply push to your Heroku or Dokku git remote.

---

### 5. Railway.app / Koyeb / Zeabur
- Uses either `Dockerfile`, `nixpacks.toml`, `Procfile`, or `railway.json`.
- Automatic detection and zero setup required.

---

## Environment Variables

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Optional | Set to `production` in live environments | `production` |
| `PORT` | Optional | HTTP & WebSocket server port (default `3000`) | `3000` / `8080` / `10000` |
| `JWT_SECRET` | Optional | Secret key for JWT admin auth token generation | `super_secure_random_string` |
| `ADMIN_USERNAME` | Optional | Superadmin username | `admin` |
| `ADMIN_PASSWORD` | Optional | Superadmin password | `secure_pass_123` |
| `ADMIN_PATH` | Optional | Custom secret path for Admin portal | `secret-admin-portal` |
| `ALLOWED_ORIGINS` | Optional | Custom CORS / WebSocket allowed origins | `https://chat.example.com,https://app.domain.com` |
| `SUPABASE_URL` | Optional | Supabase Project URL (falls back to memory if unset) | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional | Supabase Service Role Key | `eyJhbGci...` |
| `REDIS_URL` | Optional | Redis connection string (falls back to memory if unset) | `rediss://default:pass@host:port` |

---

## Core System Architecture & Fallbacks

- **Zero-Dependency Core**: If `SUPABASE_URL` or `REDIS_URL` are not supplied, the server seamlessly runs its high-performance in-memory database and caching engines.
- **WebRTC Signaling**: WebSockets dynamically adapt to `ws://` or `wss://` based on `window.location.protocol`.
- **CORS & WebSocket Origin Validation**: Automatically trusts common PaaS subdomains (`.onrender.com`, `.fly.dev`, `.koyeb.app`, `.herokuapp.com`, `.railway.app`, `.vercel.app`) as well as any domain defined in `ALLOWED_ORIGINS` or `APP_URL`.

## Release v3 fixes
- Admin authentication no longer depends on Redis session-version reads, preventing valid JWT sessions from being rejected after Redis becomes ready/reconnects.
- Admin login returns before audit logging finishes; dashboard data loads asynchronously.
- Reports aggregate repeated reports by target IP while preventing the same reporter IP from re-reporting the same target.
- Report moderation shows target IP, aggregate IP report count, unique reporter count, reason-level count, and Ban/Unban actions.
- Ban-from-report is atomic and marks all related reports for the target IP as banned.
- Admin dashboard receives Supabase Realtime changes through an authenticated admin WebSocket channel.
- Ad create/edit forms contain only the fields needed for publishing and controlling an ad.

Run SUPABASE_RELEASE_MIGRATION.sql once in the Supabase SQL Editor before production use.

## Ad media storage
Ad media is uploaded directly to the Supabase `ad-media` Storage bucket using a signed upload URL. The app no longer uses an application `uploads/` directory for ad media. The bucket is created/checked once per process when needed. The configured maximum is 20 MB.

For production, prefer creating the `ad-media` bucket in Supabase Storage ahead of time and keep `SUPABASE_SERVICE_ROLE_KEY` (or the server-side secret key) only in server environment variables.


## Release v4 hardening notes
- Keep `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEY` server-side only.
- The `ad-media` bucket should exist in Supabase Storage before production traffic; the server also checks/creates it once per process when needed.
- Run `SUPABASE_RELEASE_MIGRATION.sql` to create the report aggregation function/indexes and realtime publication entries.
- Do not commit `.env`.
