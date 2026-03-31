const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const INTERNAL_NOTIFY_TOKEN = (process.env.INTERNAL_NOTIFY_TOKEN || "").trim();
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const socketsByUid = new Map(); // uid -> Set<socketId>
const callRoomPrefix = "call:";

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

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "notification-socket" });
});

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

io.on("connection", (socket) => {
  console.log("[socket] connected", { socketId: socket.id });

  socket.on("register", ({ uid }) => {
    console.log("[notify] register", { socketId: socket.id, uid: uid || "" });
    registerSocketUid(socket, uid);
  });

  socket.on("notify_user", ({ uid, event, payload }) => {
    console.log("[notify] notify_user", {
      socketId: socket.id,
      uid: uid || "",
      event: event || "notification",
      payloadType: typeof payload,
    });
    emitToUid(uid, event || "notification", payload || {});
  });

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

  socket.on("join", ({ callId, uid }) => {
    const cleanCallId = (callId || "").toString().trim();
    const cleanUid = (uid || "").toString().trim();
    if (!cleanCallId || !cleanUid) return;
    const room = `${callRoomPrefix}${cleanCallId}`;
    socket.join(room);
    socket.data.callId = cleanCallId;
    socket.data.uid = cleanUid;
    registerSocketUid(socket, cleanUid);
    console.log("[webrtc] join", { socketId: socket.id, callId: cleanCallId, uid: cleanUid });
  });

  socket.on("offer", ({ callId, from, to, sdp }) => {
    const cleanCallId = (callId || "").toString().trim();
    if (!cleanCallId) return;
    const payload = {
      callId: cleanCallId,
      from: (from || "").toString().trim(),
      to: (to || "").toString().trim(),
      sdp: sdp || {},
    };
    const room = `${callRoomPrefix}${cleanCallId}`;
    socket.to(room).emit("offer", payload);
    console.log("[webrtc] offer", { socketId: socket.id, callId: cleanCallId, from: payload.from, to: payload.to });
  });

  socket.on("answer", ({ callId, from, to, sdp }) => {
    const cleanCallId = (callId || "").toString().trim();
    if (!cleanCallId) return;
    const payload = {
      callId: cleanCallId,
      from: (from || "").toString().trim(),
      to: (to || "").toString().trim(),
      sdp: sdp || {},
    };
    const room = `${callRoomPrefix}${cleanCallId}`;
    socket.to(room).emit("answer", payload);
    console.log("[webrtc] answer", { socketId: socket.id, callId: cleanCallId, from: payload.from, to: payload.to });
  });

  socket.on("candidate", ({ callId, from, to, candidate }) => {
    const cleanCallId = (callId || "").toString().trim();
    if (!cleanCallId) return;
    const payload = {
      callId: cleanCallId,
      from: (from || "").toString().trim(),
      to: (to || "").toString().trim(),
      candidate: candidate || {},
    };
    const room = `${callRoomPrefix}${cleanCallId}`;
    socket.to(room).emit("candidate", payload);
  });

  socket.on("end", ({ callId, from }) => {
    const cleanCallId = (callId || "").toString().trim();
    if (!cleanCallId) return;
    const payload = {
      callId: cleanCallId,
      from: (from || "").toString().trim(),
    };
    const room = `${callRoomPrefix}${cleanCallId}`;
    socket.to(room).emit("end", payload);
    console.log("[webrtc] end", { socketId: socket.id, callId: cleanCallId, from: payload.from });
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected", {
      socketId: socket.id,
      uid: socket?.data?.uid || "",
    });
    unregisterSocket(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on ${PORT}`);
});
