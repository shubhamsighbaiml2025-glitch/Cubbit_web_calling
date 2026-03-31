const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

// Initialize Firebase Admin (Uses local service-account.json or environment config)
try {
  let serviceAccount = null;
  try {
    serviceAccount = require("./service-account.json");
  } catch (e) {
    // Missing local file
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("[Firebase] Admin initialized with local service-account.json");
  } else {
    admin.initializeApp();
    console.log("[Firebase] Admin initialized with Application Default Credentials");
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
