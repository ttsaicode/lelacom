# Private Admin Path + Production Security

This build keeps the public client, WebSocket/WebRTC signaling, matchmaking, reports, bans, ads, Supabase, Redis, and the admin API in the same deployment.

## Required Railway variables

Set these in Railway Variables for production (or in local `.env` for development; never commit `.env`):

```env
ADMIN_PATH=your-random-24-plus-character-private-path
ADMIN_USERNAME=your-admin-username
ADMIN_PASSWORD=your-strong-12-plus-character-password
JWT_SECRET=your-random-32-plus-character-secret
JWT_EXPIRY=2h
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-supabase-secret
REDIS_URL=redis://user:password@host:port
ALLOWED_ORIGINS=https://your-public-site.example
SUPABASE_ADS_BUCKET=ad-media
```

## Rules

- `ADMIN_PATH` must be 24-128 characters using only letters, numbers, hyphens, or underscores in production.
- `ADMIN_PASSWORD` must be at least 12 characters and include uppercase, lowercase, a number, and a symbol.
- `JWT_SECRET` must be at least 32 characters.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never expose it to browser JavaScript.
- `ALLOWED_ORIGINS` should include the public site's browser origin. Same-origin WebSocket requests are always allowed; other browser origins are rejected in production unless listed.

## URLs

Public client:
`/`

Public admin guess:
`/admin` -> 404 Not Found

Private admin:
`/<ADMIN_PATH>`

The admin APIs remain under `/api/admin/*` and require a valid JWT.

## Session security

- JWTs use HS256 with issuer/audience validation and a short default lifetime.
- Logout revokes the token; Redis is used when available so revocation survives a restart.
- Password changes, role changes, staff password resets, and admin deletion bump the admin session version and invalidate existing sessions.
- Failed admin logins are rate-limited and locked for 15 minutes after repeated failures; Redis is used when available for shared limits.

## Production startup checks

Production startup fails closed if `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_PATH`, `SUPABASE_URL`, or `SUPABASE_SERVICE_ROLE_KEY` are missing or weak.
