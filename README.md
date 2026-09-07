# WhatsApp CRM & Broadcast Dashboard

A self-hosted, fully containerized WhatsApp broadcast CRM built with **React, TypeScript, Vite, Tailwind CSS, Express, Prisma, SQLite, and whatsapp-web.js**.

Link multiple WhatsApp accounts by QR code, import contact groups with custom variables, manage message templates, and run automated campaigns with randomized send intervals, working-hour windows, per-account daily limits, and sender rotation.

---

## Folder Structure

```
.
├── docker-compose.yml          # Main Docker orchestration file
├── README.md                   # Setup and usage guide
├── UI_use_instruction.md       # Design tokens and UI conventions
├── frontend/                   # React dashboard (Vite + TS)
│   ├── src/
│   │   ├── pages/              # Accounts, Contacts, Templates, Campaigns, Proxies, QR
│   │   ├── components/ui/      # shadcn/ui primitives
│   │   └── lib/api.ts          # API + WebSocket endpoint resolution
│   ├── nginx.conf              # Nginx proxy for assets, API, and WebSockets
│   └── Dockerfile              # Multi-stage production build
└── backend/                    # Node.js API & whatsapp-web.js engine
    ├── src/
    │   ├── routes/             # accounts, contacts, templates, campaigns, proxies
    │   ├── services/scheduler.ts  # Campaign send loop, pacing, retries
    │   └── whatsapp.ts         # Client pool, QR lifecycle, session janitor
    ├── prisma/                 # SQLite database schema
    └── Dockerfile              # Runs Puppeteer/headless Chrome inside Docker
```

---

## Features

### Account management
- **Multi-account session manager.** Each linked number runs its own headless Chromium client. Sessions live in a mounted volume, so containers can restart without forcing a re-scan.
- **Live status over WebSocket.** QR codes, connection state, and removals are pushed to the dashboard as they happen — no polling, no stale rows.
- **Shareable connect links.** Generate a `/connect/:id` link and send it to a colleague so they can scan on their own phone without touching the dashboard.
- **Per-proxy connections.** Accounts can be bound to a proxy (`host:port` or `host:port:user:pass`), managed on the Proxies page.
- **Self-cleaning unscanned profiles.** A profile that is never linked to a phone number is disposable: it lives for the QR window plus a grace period (5 minutes by default) from its last connect attempt, then a janitor deletes it and its session directory. Refreshing the QR restarts the clock. The Accounts table shows these rows dimmed with a live countdown. Profiles created through a shareable connect link are exempt, so a link you have already sent out will not expire from under the recipient.

### Contacts and templates
- **Dynamic variable substitution.** Import contacts with variables (semicolon `;` separated) and reference them in templates as `{{field_1}}`, `{{field_2}}`, and so on.
- **WhatsApp presence check.** Verify that a number is actually registered on WhatsApp before it is queued.

### Broadcast engine
- **Randomized pacing.** Each campaign sends on a random interval between its `minInterval` and `maxInterval` rather than a fixed cadence.
- **Working hours.** Sends only inside the campaign's `sendFrom`–`sendTo` window, evaluated in the container's timezone.
- **Per-account daily limits.** Set a `dailyLimit` per account; the counter rolls over on the calendar day and an account that hits its cap is skipped until the next day.
- **Sender rotation.** Campaigns rotate across their selected connected accounts, skipping any that are disconnected, banned, or capped.
- **Automatic retries.** A failed recipient is retried with exponential backoff (5 min, 10 min, 20 min …) up to 3 attempts before it is marked failed.

---

## Local Development (Without Docker)

Run both services independently.

### 1. Backend
```bash
cd backend
npm install
npx prisma db push     # creates ../data/database.db and generates the client
npm run dev            # http://localhost:5000
```

### 2. Frontend
```bash
cd frontend
npm install
npm run dev            # http://localhost:8080
```

In dev the frontend defaults to `http://localhost:5000/api` and `ws://localhost:5000`. Override them if your backend is elsewhere:

```bash
VITE_API_URL=http://localhost:5001/api VITE_WS_URL=ws://localhost:5001 npm run dev
```

> **Note:** if a production stack is already bound to port 5000 on the same machine, start the dev backend with `PORT=5001` and point the frontend at it as shown above rather than stopping the running stack.

---

## Production Deployment (With Docker Compose)

Docker Compose builds the frontend, installs headless Chrome dependencies in the backend, and mounts volumes to preserve login state and data.

### 1. Prerequisites
**Docker** and **Docker Compose** on your VPS or server.

### 2. Launch
```bash
docker-compose up --build -d
```

This starts:
- **Backend API & WhatsApp service** on port `5000`
- **Frontend SPA served via Nginx** on port `4628`

The backend container runs `npx prisma db push` on every start, so schema changes apply automatically on redeploy — no migration step to remember.

### 3. Accessing the dashboard
`http://<your-server-ip>:4628` (or `http://localhost:4628` locally).

### 4. Customizing the port
Edit the frontend port mapping in `docker-compose.yml`:
```yaml
  frontend:
    ...
    ports:
      - "80:80"   # Exposes the frontend on standard port 80
```

### 5. Persistent data
Two named volumes are mounted automatically and survive container updates and reboots:
- `backend-sessions` → `/app/sessions`, the WhatsApp auth states, so scanning is only required once.
- `backend-data` → `/app/data`, the SQLite database file (`database.db`).

---

## Configuration

All of these are optional and have working defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` | Backend HTTP/WebSocket port. |
| `DATABASE_URL` | `file:../data/database.db` | SQLite location. The compose file points it at the mounted volume. |
| `TZ` | `Asia/Almaty` | **Important.** Campaign working hours and daily-limit rollover follow this clock. Without it the container runs on UTC and every send window is silently shifted. |
| `QR_WINDOW_MS` | `180000` (3 min) | How long a generated QR code stays valid. |
| `PENDING_GRACE_MS` | `120000` (2 min) | Extra time an unscanned profile survives after its QR expires before it is deleted. |
| `MAX_SEND_ATTEMPTS` | `3` | Attempts per recipient before it is marked failed. |
| `RETRY_BASE_MS` | `300000` (5 min) | First retry delay; each further attempt doubles it. |
| `PUPPETEER_EXECUTABLE_PATH` | bundled Chromium | Path to a system Chrome, set by the backend Dockerfile. |
| `VITE_API_URL` / `VITE_WS_URL` | derived from the page origin | Frontend build-time overrides for the API and WebSocket endpoints. |

---

## Notes

- The dashboard has **no authentication layer** and is intended for a trusted LAN or a network you control. Do not expose port `4628` directly to the public internet.
- The app uses `whatsapp-web.js`, which automates a real WhatsApp Web session. Respect WhatsApp's terms and send responsibly — the pacing, working-hour, and daily-limit controls exist for that reason.
