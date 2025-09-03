require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Enable compression in socket.io
const io = new Server(server, {
  cors: { origin: "*" },
  perMessageDeflate: true,
});

const state = Object.create(null);
const keyFor = (userId) => (userId && String(userId).trim()) || "default";

// Store pending updates (to batch within 500ms)
let pendingUpdates = {};

function scheduleUpdate(userId, updateType, data) {
  if (!pendingUpdates[userId]) {
    pendingUpdates[userId] = [];
  }
  pendingUpdates[userId].push({ type: updateType, data });
}

// Every 500ms send all pending updates at once
setInterval(() => {
  for (const userId in pendingUpdates) {
    const updates = pendingUpdates[userId];
    if (updates.length > 0) {
      io.to(userId).emit("bulk-update", updates);
      pendingUpdates[userId] = [];
    }
  }
}, 500);

// REST API
app.get("/api/health", (req, res) => {
  res.send("Server is healthy!");
});

app.get("/api/state/:userId?", (req, res) => {
  const userId = req.params.userId || "default";
  res.json(state[keyFor(userId)] || {});
});

// Socket.IO logic
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join", (userId) => {
    const key = keyFor(userId);
    if (!state[key]) {
      state[key] = { matchData: {}, overlays: {}, wagonData: {}, updatedAt: Date.now() };
    }
    socket.join(key);
    socket.emit("init-state", state[key]);
  });

  socket.on("publish-update", ({ userId, matchData, overlays }) => {
    const key = keyFor(userId);
    if (!state[key]) {
      state[key] = { matchData: {}, overlays: {}, wagonData: {}, updatedAt: Date.now() };
    }

    const changes = {};
    if (matchData && JSON.stringify(matchData) !== JSON.stringify(state[key].matchData)) {
      state[key].matchData = matchData;
      changes.matchData = matchData;
    }
    if (overlays && JSON.stringify(overlays) !== JSON.stringify(state[key].overlays)) {
      state[key].overlays = overlays;
      changes.overlays = overlays;
    }
    state[key].updatedAt = Date.now();

    if (Object.keys(changes).length > 0) {
      scheduleUpdate(key, "update", changes);
    }
  });

  socket.on("publish-wagon", ({ userId, wagonData }) => {
    const key = keyFor(userId);
    if (!state[key]) {
      state[key] = { matchData: {}, overlays: {}, wagonData: {}, updatedAt: Date.now() };
    }

    if (wagonData && JSON.stringify(wagonData) !== JSON.stringify(state[key].wagonData)) {
      state[key].wagonData = wagonData;
      state[key].updatedAt = Date.now();
      scheduleUpdate(key, "wagon", { wagonData });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Optimized Backend listening on ${PORT}`);
});
