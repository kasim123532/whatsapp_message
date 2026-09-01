# WhatsApp CRM & Broadcast Dashboard

A fully containerized self-hosted WhatsApp Broadcast CRM dashboard built with **React, TypeScript, Vite, Tailwind CSS, Express, Prisma, SQLite, and whatsapp-web.js**. 

This project allows you to connect multiple WhatsApp accounts via QR codes, import contact groups with custom variables, manage message templates, and run automated broadcast campaigns with staggered sending intervals, respect for working hours, and sender rotation.

---

## Folder Structure

```
.
├── docker-compose.yml          # Main Docker orchestration file
├── README.md                   # Setup and usage guide
├── frontend/                   # React dashboard (Vite + TS)
│   ├── src/
│   ├── nginx.conf              # Nginx proxy for assets, API, and WebSockets
│   └── Dockerfile              # Multi-stage production build
└── backend/                    # Node.js API & whatsapp-web.js engine
    ├── src/
    ├── prisma/                 # SQLite database schema
    └── Dockerfile              # Running Puppeteer/headless Chrome inside Docker
```

---

## Features

- **WhatsApp Session Manager**: Multi-device login using QR code generation. Sessions are stored in a mounted volume to prevent logout when containers restart.
- **Dynamic Variable substitution**: Import contacts with variables (using semicolon `;` as separator), which are parsed and substituted dynamically in template messages (e.g. `{{field_1}}`, `{{field_2}}`).
- **Broadcast Engine**: Schedule campaigns, specify message sending intervals (e.g., between 60s and 120s), set working hours (e.g., send only between 9:00 and 19:00), and rotate active connected accounts.
- **WhatsApp Presence Check**: Verify if contact numbers are registered on WhatsApp before queuing.

---

## Local Development (Without Docker)

You can run both services independently for development purposes.

### 1. Backend Setup
1. Open a terminal and navigate to the backend folder:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Initialize the database:
   ```bash
   npx prisma db push
   ```
4. Start the development server (runs on `http://localhost:5000`):
   ```bash
   npm run dev
   ```

### 2. Frontend Setup
1. Open another terminal and navigate to the frontend folder:
   ```bash
   cd frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the Vite server (runs on `http://localhost:5173`):
   ```bash
   npm run dev
   ```
4. Access the web app at `http://localhost:5173`.

---

## Production Deployment (With Docker Compose)

The easiest way to run the entire app in production is using Docker Compose. It compiles the frontend, installs headless Chrome dependencies in the backend, and mounts volumes to preserve login states and data.

### 1. Prerequisites
Ensure you have **Docker** and **Docker Compose** installed on your VPS or server.

### 2. Launch the Application
Run the following command from the project root:
```bash
docker-compose up --build -d
```

This will build and start:
- **Backend API & WhatsApp service** (internal, exposed on port `5000`)
- **Frontend SPA served via Nginx** (exposed on port `4628`)

### 3. Accessing the Dashboard
Open your browser and navigate to:
`http://<your-server-ip>:4628` (or `http://localhost:4628` if running locally).

### 4. Customizing Port
If you want to run the app on port `80` (default web port), edit the `docker-compose.yml` file and change the port mapping for the frontend service:
```yaml
  frontend:
    ...
    ports:
      - "80:80"   # Exposes the frontend on standard port 80
```

### 5. Persistent Data
The containers automatically mount two persistent Docker volumes:
- `backend-sessions`: Stores the WhatsApp auth states so scanning is only required once.
- `backend-data`: Stores the SQLite database file (`database.db`).
Both volumes survive container updates and system reboots.
