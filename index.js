const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

function _normalizePrivateKey(value) {
  if (typeof value !== "string") return "";
  let key = value.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n");
}

function _isPlaceholder(value) {
  return !value || value === "REPLACE_ME";
}

function _isValidServiceAccount(serviceAccount) {
  if (!serviceAccount || typeof serviceAccount !== "object") return false;
  const projectId = (serviceAccount.project_id || "").toString().trim();
  const clientEmail = (serviceAccount.client_email || "").toString().trim();
  const privateKey = (serviceAccount.private_key || "").toString().trim();
  if (
    _isPlaceholder(projectId) ||
    _isPlaceholder(clientEmail) ||
    _isPlaceholder(privateKey)
  ) {
    return false;
  }
  return (
    privateKey.includes("BEGIN PRIVATE KEY") &&
    privateKey.includes("END PRIVATE KEY")
  );
}

function _serviceAccountFromEnv() {
  const projectId = (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    ""
  )
    .toString()
    .trim();
  const clientEmail = (
    process.env.FIREBASE_CLIENT_EMAIL ||
    process.env.GOOGLE_CLIENT_EMAIL ||
    ""
  )
    .toString()
    .trim();
  const privateKey = _normalizePrivateKey(
    process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || ""
  );
  const privateKeyId = (
    process.env.FIREBASE_PRIVATE_KEY_ID ||
    process.env.GOOGLE_PRIVATE_KEY_ID ||
    ""
  )
    .toString()
    .trim();

  const candidate = {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
  };
  if (privateKeyId) {
    candidate.private_key_id = privateKeyId;
  }
  return candidate;
}

// Initialize Firebase Admin (prefers env vars; falls back to local file)
try {
  let localServiceAccount = null;
  try {
    localServiceAccount = require("./service-account.json");
  } catch (e) {
    // Missing local file
  }

  const envServiceAccount = _serviceAccountFromEnv();
  const hasValidEnvServiceAccount = _isValidServiceAccount(envServiceAccount);
  const hasValidLocalServiceAccount = _isValidServiceAccount(localServiceAccount);

  if (hasValidEnvServiceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(envServiceAccount),
    });
    console.log("[Firebase] Admin initialized with Render environment variables");
  } else if (hasValidLocalServiceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(localServiceAccount),
    });
    console.log("[Firebase] Admin initialized with local service-account.json");
  } else {
    admin.initializeApp();
    console.log(
      "[Firebase] Admin initialized with Application Default Credentials (no explicit service account)"
    );
  }
} catch (err) {
  console.log("[Firebase] Admin init error:", err.message);
}

const PORT = process.env.PORT || 3001;
const INTERNAL_NOTIFY_TOKEN = (process.env.INTERNAL_NOTIFY_TOKEN || "").trim();
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Email Configuration (Brevo) ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: "a70ba5001@smtp-brevo.com",
    pass: "xsmtpsib-06225f5c0c942b47f078f17e53580edab67ad5f9aa7149771f6fe33830022d2f-PPZK2Q95h8w9vdTA"
  }
});

// uid -> Set<socketId>
const socketsByUid = new Map();

function registerSocketUid(socket, uidRaw) {
  const uid = (uidRaw || "").toString().trim();
  if (!uid) return;
  socket.data.uid = uid;
  if (!socketsByUid.has(uid)) {
    socketsByUid.set(uid, new Set());
  }
  socketsByUid.get(uid).add(socket.id);
}

function unregisterSocket(socket) {
  const uid = (socket?.data?.uid || "").toString().trim();
  if (!uid) return;
  const set = socketsByUid.get(uid);
  if (!set) return;
  set.delete(socket.id);
  if (set.size === 0) {
    socketsByUid.delete(uid);
  }
}

function emitToUid(uidRaw, event, payload) {
  const uid = (uidRaw || "").toString().trim();
  if (!uid) return 0;
  const ids = socketsByUid.get(uid);
  if (!ids || ids.size === 0) return 0;
  let count = 0;
  for (const socketId of ids) {
    io.to(socketId).emit(event, payload);
    count++;
  }
  return count;
}

// ─── HTTP endpoints ────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "cubbit-notification-socket", version: "2.0.0" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, connections: socketsByUid.size });
});

/** Welcome Email Endpoint (Free replacement for Firebase Functions) */
app.post("/api/welcome-email", async (req, res) => {
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: "email required" });

  const mailOptions = {
    from: "Cubbit Support <a70ba5001@smtp-brevo.com>",
    to: email,
    subject: "Welcome to Cubbit 🎉",
    text: `Hi ${name || 'there'},\n\nThank you for downloading Cubbit!\n\nJoin Cubbit Community:\nOpen Cubbit App → Search → "Cubbit Community"\n\nNeed help?\nSinghshubham29392@gmail.com\nanibeshsingh2@gmail.com\n\nDownload latest version:\nhttps://cubbit-web.onrender.com/`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Email] Welcome email sent to ${email}`);
    return res.json({ ok: true });
  } catch (error) {
    console.error("[Email] Error sending welcome email:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/** Push a notification event to a connected user by uid. */
app.post("/notify-user", (req, res) => {
  if (INTERNAL_NOTIFY_TOKEN) {
    const auth = (req.headers.authorization || "").toString();
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : "";
    if (!token || token !== INTERNAL_NOTIFY_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  const uid = (req.body?.uid || "").toString().trim();
  const event = (req.body?.event || "notification").toString().trim();
  const payload = req.body?.payload ?? {};
  if (!uid) {
    return res.status(400).json({ ok: false, error: "uid required" });
  }

  const delivered = emitToUid(uid, event, payload);
  return res.json({ ok: true, delivered });
});

// ─── FCM Push Notification relay (App → NodeJS → Google FCM) ────────────────
app.post("/api/notify", async (req, res) => {
  const { tokens, data, notificationTitle, notificationBody, highPriority } = req.body || {};

  if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ ok: false, error: "tokens required" });
  }

  // Determine if Firebase Admin is fully initialized before attempting to send.
  if (admin.apps.length === 0) {
    console.error("[FCM] Admin SDK not initialized; missing service-account.json?");
    return res.status(500).json({ ok: false, error: "Server missing Firebase configuration." });
  }

  const message = {
    tokens: tokens,
    data: data || {},
    android: {
      priority: highPriority ? "high" : "normal",
      notification: {
        channelId: "high_importance_channel",
        sound: "default",
        defaultSound: true,
        defaultVibrateTimings: true,
      },
      ttl: highPriority ? 30000 : 3600000,
    },
    apns: {
      headers: {
        "apns-priority": highPriority ? "10" : "5",
        "apns-expiration": highPriority ? "30" : "3600",
      },
      payload: {
        aps: {
          "content-available": 1,
          sound: "default",
        },
      },
    }
  };

  if (notificationTitle) {
    message.notification = {
      title: notificationTitle,
      body: notificationBody || "",
    };
  }

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`[FCM] Sent message successfully: ${response.successCount} sent, ${response.failureCount} failed.`);
    return res.json({ ok: true, successCount: response.successCount, failureCount: response.failureCount });
  } catch (error) {
    console.error("[FCM] Error sending message:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ─── Socket events ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("[socket] connected", { socketId: socket.id });

  // Register the authenticated user uid with this socket.
  socket.on("register", ({ uid }) => {
    console.log("[notify] register", { socketId: socket.id, uid: uid || "" });
    registerSocketUid(socket, uid);
  });

  // Generic notification relay: { uid, event, payload }
  socket.on("notify_user", ({ uid, event, payload }) => {
    console.log("[notify] notify_user", {
      socketId: socket.id,
      uid: uid || "",
      event: event || "notification",
    });
    emitToUid(uid, event || "notification", payload || {});
  });

  // Call invite relay — sender pushes invite to callee instantly (socket path).
  // Firebase Cloud Functions handle the FCM path for killed/background apps.
  socket.on("call_invite_user", ({ uid, callId, callerUid, callerName, isVideo }) => {
    console.log("[notify] call_invite_user", {
      socketId: socket.id,
      uid: uid || "",
      callId: callId || "",
      callerUid: callerUid || "",
      callerName: callerName || "",
      isVideo: !!isVideo,
    });
    emitToUid(uid, "call_invite", {
      type: "call_invite",
      callId: callId || "",
      callerUid: callerUid || "",
      callerName: callerName || "Incoming call",
      calleeUid: uid || "",
      isVideo: !!isVideo,
    });
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected", {
      socketId: socket.id,
      uid: socket?.data?.uid || "",
    });
    unregisterSocket(socket);
  });
});

// ─── Start server ──────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Cubbit notification server listening on port ${PORT}`);
});
