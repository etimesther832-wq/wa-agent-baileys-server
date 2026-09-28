const express = require("express");
const path = require("path");
const fs = require("fs");
const P = require("pino");
const QRCode = require("qrcode");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
 * Persistent storage.
 *
 * On Blitz, mount your persistent volume at:
 *
 * /app/sessions
 *
 * Each WhatsApp account gets its own folder.
 */

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = P({ level: "info" });

/*
 * Active WhatsApp connections.
 *
 * sessionId -> {
 *   sock,
 *   status,
 *   qr,
 *   pairingCode,
 *   phone
 * }
 */

const connections = new Map();

/*
 * Prevent multiple simultaneous connection attempts
 * for the same session.
 */

const connecting = new Set();

function sessionPath(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

function safeSessionId(id) {
  return String(id || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
}

/*
 * Start a WhatsApp connection.
 */

async function connectWhatsApp(sessionId) {
  sessionId = safeSessionId(sessionId);

  if (!sessionId) {
    throw new Error("Invalid sessionId");
  }

  if (connecting.has(sessionId)) {
    return connections.get(sessionId);
  }

  connecting.add(sessionId);

  try {
    const authPath = sessionPath(sessionId);

    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }

    const { state, saveCreds } =
      await useMultiFileAuthState(authPath);

    let version;

    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;

      console.log(
        `[${sessionId}] WhatsApp version: ${version.join(".")}`
      );
    } catch (error) {
      console.log(
        `[${sessionId}] Could not fetch WhatsApp version:`,
        error.message
      );
    }

    const existing = connections.get(sessionId);

    if (existing && existing.sock) {
      try {
        existing.sock.end();
      } catch {}
    }

    const connectionInfo = {
      sock: null,
      status: "connecting",
      qr: null,
      pairingCode: null,
      phone: null,
      lastError: null,
      connectedAt: null
    };

    connections.set(sessionId, connectionInfo);

    const socketOptions = {
      auth: state,
      logger,
      browser: Browsers.macOS("WA Agent Studio"),
      markOnlineOnConnect: false,
      printQRInTerminal: false
    };

    if (version) {
      socketOptions.version = version;
    }

    const sock = makeWASocket(socketOptions);

    connectionInfo.sock = sock;

    /*
     * Save credentials whenever Baileys changes them.
     */

    sock.ev.on("creds.update", saveCreds);

    /*
     * Connection updates.
     */

    sock.ev.on("connection.update", async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      const info = connections.get(sessionId);

      if (!info) return;

      if (qr) {
        info.qr = qr;

        console.log(`[${sessionId}] New QR code generated`);

        try {
          info.qrDataUrl = await QRCode.toDataURL(qr);
        } catch (error) {
          console.log(
            `[${sessionId}] QR generation error:`,
            error.message
          );
        }
      }

      if (connection === "connecting") {
        info.status = "connecting";
        console.log(`[${sessionId}] Connecting...`);
      }

      if (connection === "open") {
        info.status = "connected";
        info.qr = null;
        info.qrDataUrl = null;
        info.pairingCode = null;
        info.connectedAt = new Date().toISOString();
        info.lastError = null;

        if (sock.user) {
          info.phone =
            sock.user.id?.split(":")[0] ||
            sock.user.id ||
            null;
        }

        console.log(
          `[${sessionId}] WHATSAPP CONNECTED`
        );
      }

      if (connection === "close") {
        const statusCode =
          new Boom(lastDisconnect?.error)?.output
            ?.statusCode;

        info.status = "disconnected";

        console.log(
          `[${sessionId}] Connection closed. Code:`,
          statusCode
        );

        /*
         * Logged out means the WhatsApp device was removed.
         * We do NOT automatically reconnect in that case.
         */

        if (statusCode === DisconnectReason.loggedOut) {
          info.status = "logged_out";

          console.log(
            `[${sessionId}] Logged out. Session requires new pairing.`
          );

          return;
        }

        /*
         * Other disconnects are normally temporary.
         * Reconnect after a short delay.
         */

        console.log(
          `[${sessionId}] Reconnecting in 3 seconds...`
        );

        setTimeout(() => {
          connectWhatsApp(sessionId).catch((error) => {
            console.error(
              `[${sessionId}] Reconnect failed:`,
              error.message
            );
          });
        }, 3000);
      }
    });

    /*
     * Incoming messages.
     */

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages) {
        if (!message.message) continue;

        const remoteJid = message.key.remoteJid;

        if (!remoteJid) continue;

        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          "";

        console.log(
          `[${sessionId}] MESSAGE from ${remoteJid}: ${text}`
        );

        /*
         * Later we will send this event to
         * WA Agent Studio so the AI can respond.
         */
      }
    });

    return connectionInfo;
  } finally {
    connecting.delete(sessionId);
  }
}

/*
 * Health check.
 */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "wa-agent-baileys-server",
    time: new Date().toISOString()
  });
});

/*
 * Start/connect a WhatsApp session.
 *
 * Example:
 *
 * POST /connect
 *
 * {
 *   "sessionId": "test1"
 * }
 */

app.post("/connect", async (req, res) => {
  try {
    const sessionId = safeSessionId(
      req.body.sessionId || "test1"
    );

    const info = await connectWhatsApp(sessionId);

    res.json({
      success: true,
      sessionId,
      status: info.status
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*
 * Request a WhatsApp pairing code.
 *
 * POST /pair
 *
 * {
 *   "sessionId": "test1",
 *   "phone": "2348012345678"
 * }
 *
 * Phone number must contain country code
 * and numbers only.
 */

app.post("/pair", async (req, res) => {
  try {
    const sessionId = safeSessionId(
      req.body.sessionId || "test1"
    );

    const phone = String(req.body.phone || "")
      .replace(/\D/g, "");

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Phone number is required"
      });
    }

    let info = connections.get(sessionId);

    if (!info || !info.sock) {
      await connectWhatsApp(sessionId);
      info = connections.get(sessionId);
    }

    if (!info || !info.sock) {
      return res.status(500).json({
        success: false,
        error: "WhatsApp socket is not ready"
      });
    }

    if (info.sock.authState?.creds?.registered) {
      return res.status(400).json({
        success: false,
        error: "This session is already registered"
      });
    }

    /*
     * Give the socket a moment to initialize.
     */

    await new Promise((resolve) =>
      setTimeout(resolve, 2000)
    );

    const code =
      await info.sock.requestPairingCode(phone);

    info.pairingCode = code;
    info.status = "pairing";

    res.json({
      success: true,
      sessionId,
      phone,
      pairingCode: code
    });
  } catch (error) {
    console.error("PAIRING ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*
 * Get session status.
 */

app.get("/status/:sessionId", (req, res) => {
  const sessionId = safeSessionId(
    req.params.sessionId
  );

  const info = connections.get(sessionId);

  if (!info) {
    return res.json({
      success: true,
      sessionId,
      status: "not_started",
      connected: false
    });
  }

  res.json({
    success: true,
    sessionId,
    status: info.status,
    connected: info.status === "connected",
    phone: info.phone,
    pairingCode: info.pairingCode,
    qr: info.qrDataUrl || null,
    connectedAt: info.connectedAt,
    lastError: info.lastError
  });
});

/*
 * Send a text message.
 *
 * POST /send-message
 *
 * {
 *   "sessionId": "test1",
 *   "to": "2348012345678",
 *   "message": "Hello"
 * }
 */

app.post("/send-message", async (req, res) => {
  try {
    const sessionId = safeSessionId(
      req.body.sessionId
    );

    const to = String(req.body.to || "")
      .replace(/\D/g, "");

    const message = String(
      req.body.message || ""
    );

    if (!sessionId || !to || !message) {
      return res.status(400).json({
        success: false,
        error:
          "sessionId, to and message are required"
      });
    }

    const info = connections.get(sessionId);

    if (!info || !info.sock) {
      return res.status(400).json({
        success: false,
        error: "Session is not connected"
      });
    }

    if (info.status !== "connected") {
      return res.status(400).json({
        success: false,
        error: `Session status is ${info.status}`
      });
    }

    const jid = `${to}@s.whatsapp.net`;

    const result =
      await info.sock.sendMessage(jid, {
        text: message
      });

    res.json({
      success: true,
      messageId: result?.key?.id || null
    });
  } catch (error) {
    console.error("SEND ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*
 * Logout a WhatsApp session.
 */

app.post("/logout", async (req, res) => {
  try {
    const sessionId = safeSessionId(
      req.body.sessionId
    );

    const info = connections.get(sessionId);

    if (info?.sock) {
      await info.sock.logout();
    }

    connections.delete(sessionId);

    res.json({
      success: true,
      sessionId,
      status: "logged_out"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*
 * Start HTTP server.
 */

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("====================================");
  console.log(" WA AGENT STUDIO - BAILEYS SERVER");
  console.log("====================================");
  console.log(`Port: ${PORT}`);
  console.log(`Sessions: ${SESSIONS_DIR}`);
  console.log("Server is running.");
  console.log("====================================");
  console.log("");
});
