# WA Agent Studio - Baileys Server

Cloud WhatsApp bridge for WA Agent Studio using Baileys.

## Deployment on Blitz Cloud

### Requirements
- Node.js 20+
- Persistent volume at `/app/sessions` for WhatsApp authentication data

### Build & Deploy

1. **Blitz Project Settings:**
   - Runtime: Docker
   - Dockerfile: `Dockerfile`
   - Port: `8080` (internal)
   - Persistent Volume: `/app/sessions`

2. **Environment Variables:**
   - `PORT=8080` (Blitz will override this automatically)
   - `SESSIONS_DIR=/app/sessions` (optional, defaults to `/app/sessions`)

3. **Build Command:**
   ```bash
   docker build -t wa-agent-baileys-server .
   ```

4. **Run Locally:**
   ```bash
   docker run -p 8080:8080 -v sessions:/app/sessions wa-agent-baileys-server
   ```

### API Endpoints

#### Health Check
```bash
GET /health
```
Returns server status.

#### Start/Connect WhatsApp Session
```bash
POST /connect
Content-Type: application/json

{
  "sessionId": "user1"
}
```

#### Request Pairing Code
```bash
POST /pair
Content-Type: application/json

{
  "sessionId": "user1",
  "phone": "2348012345678"
}
```
Phone number must include country code, digits only.

#### Get Session Status
```bash
GET /status/user1
```

#### Send Message
```bash
POST /send-message
Content-Type: application/json

{
  "sessionId": "user1",
  "to": "2348012345678",
  "message": "Hello"
}
```

#### Logout Session
```bash
POST /logout
Content-Type: application/json

{
  "sessionId": "user1"
}
```

### Session Management

- Each WhatsApp account has its own folder in `/app/sessions/<sessionId>`
- Sessions persist across container restarts (requires persistent volume)
- Up to 5 isolated concurrent sessions supported
- QR codes generated as data URLs for pairing

### Troubleshooting

Check logs:
```bash
docker logs <container-id>
```

Expected startup output:
```
====================================
 WA AGENT STUDIO - BAILEYS SERVER
====================================
Port: 8080
Sessions: /app/sessions
Server is running.
====================================
```
