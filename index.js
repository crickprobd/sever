require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

// In-memory store (can be replaced with DB later if needed)
// state[userIdOrDefault] = { matchData, overlays, wagonData, updatedAt }
const state = Object.create(null);
const keyFor = (userId) => (userId && String(userId).trim()) || 'default';

const app = express();
const server = http.createServer(app);
// Tune Node HTTP keep-alive to avoid premature proxy timeouts
server.keepAliveTimeout = 65000; // 65s
server.headersTimeout = 70000;   // 70s

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json({ limit: '10mb' }));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Get current state for default user
app.get('/api/state', (_req, res) => {
  const k = keyFor(undefined);
  const s = state[k] || { matchData: null, overlays: {}, wagonData: [], updatedAt: null };
  res.json({ success: true, ...s });
});

// Get current state for a specific userId
app.get('/api/state/:userId', (req, res) => {
  const k = keyFor(req.params.userId);
  const s = state[k] || { matchData: null, overlays: {}, wagonData: [], updatedAt: null };
  res.json({ success: true, ...s });
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket'],  // prefer pure WebSocket for lower latency
  pingInterval: 15000,        // server heartbeat every 15s
  pingTimeout: 30000          // wait up to 30s for pong
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join', (payload) => {
    const k = keyFor(payload && payload.userId);
    socket.join(k);
    socket.data.userRoom = k;
    // Optionally send current state
    const s = state[k] || { matchData: null, overlays: {}, wagonData: [], updatedAt: null };
    socket.emit('match-update', { ...s });
  });

  socket.on('publish-update', (payload = {}) => {
    const { userId, matchData, overlays } = payload;
    const k = keyFor(userId);
    const prev = state[k] || { matchData: null, overlays: {}, wagonData: [] };
    state[k] = {
      matchData: matchData !== undefined ? matchData : prev.matchData,
      overlays: overlays !== undefined ? { ...prev.overlays, ...overlays } : prev.overlays,
      wagonData: prev.wagonData,
      updatedAt: new Date().toISOString()
    };
    io.to(k).emit('match-update', state[k]);
  });

  socket.on('publish-wagon', (payload = {}) => {
    const { userId, wagonData } = payload;
    const k = keyFor(userId);
    const prev = state[k] || { matchData: null, overlays: {}, wagonData: [] };
    state[k] = {
      matchData: prev.matchData,
      overlays: prev.overlays,
      wagonData: Array.isArray(wagonData) ? wagonData : prev.wagonData,
      updatedAt: new Date().toISOString()
    };
    io.to(k).emit('match-update', state[k]);
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Backend listening on ${PORT} (build: no-optional-route)`);
});
