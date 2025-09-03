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

// Helpers
const isPlainObject = (v) => Object.prototype.toString.call(v) === '[object Object]';

// Compute deep diff ops between prev and next. Arrays are treated as replace when changed.
// Returns ops as [{ op: 'set', path: 'a.b.c', value: any }]
const deepDiffOps = (prev, next, basePath = '') => {
  const ops = [];
  const addOp = (path, value) => ops.push({ op: 'set', path, value });

  const allKeys = new Set([
    ...Object.keys(isPlainObject(prev) ? prev : {}),
    ...Object.keys(isPlainObject(next) ? next : {})
  ]);
  for (const key of allKeys) {
    const p = isPlainObject(prev) ? prev[key] : undefined;
    const n = isPlainObject(next) ? next[key] : undefined;
    const path = basePath ? `${basePath}.${key}` : key;

    if (n === undefined) {
      // For simplicity: if a key is removed, we set it to undefined (client can delete if desired)
      addOp(path, undefined);
      continue;
    }

    if (isPlainObject(p) && isPlainObject(n)) {
      ops.push(...deepDiffOps(p, n, path));
    } else if (Array.isArray(p) && Array.isArray(n)) {
      // If arrays differ (length or any element), replace the entire array
      const changed = p.length !== n.length || p.some((v, i) => JSON.stringify(v) !== JSON.stringify(n[i]));
      if (changed) addOp(path, n);
    } else {
      if (JSON.stringify(p) !== JSON.stringify(n)) addOp(path, n);
    }
  }
  return ops;
};

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
    const prev = state[k] || { matchData: {} , overlays: {}, wagonData: [] };

    const next = {
      matchData: matchData !== undefined ? matchData : prev.matchData || {},
      overlays: overlays !== undefined ? { ...prev.overlays, ...overlays } : prev.overlays || {},
      wagonData: prev.wagonData,
    };

    // Deep diff ops
    let ops = [];
    if (isPlainObject(matchData)) {
      ops = ops.concat(deepDiffOps(prev.matchData || {}, matchData, 'matchData'));
    }
    if (isPlainObject(overlays)) {
      ops = ops.concat(deepDiffOps(prev.overlays || {}, overlays, 'overlays'));
    }

    // Persist new state
    state[k] = {
      matchData: next.matchData,
      overlays: next.overlays,
      wagonData: next.wagonData,
      updatedAt: new Date().toISOString()
    };

    // Extract score patch if present (expecting object)
    let sentScore = false;
    if (isPlainObject(matchData) && isPlainObject(matchData.score)) {
      const prevScore = (prev.matchData && prev.matchData.score) || {};
      const nextScore = matchData.score || {};
      const scorePatch = {};
      for (const key of new Set([...Object.keys(prevScore), ...Object.keys(nextScore)])) {
        if (nextScore[key] !== prevScore[key]) scorePatch[key] = nextScore[key];
      }
      if (Object.keys(scorePatch).length > 0) {
        io.to(k).emit('score-update', scorePatch);
        sentScore = true;
        // Filter out ops under matchData.score.* so we don't duplicate
        ops = ops.filter(op => !(op.path === 'matchData.score' || op.path.startsWith('matchData.score.')));
      }
    }

    // Emit deep state patch if any ops remain
    if (ops.length > 0) {
      io.to(k).emit('state-patch', ops);
    }
  });

  socket.on('publish-wagon', (payload = {}) => {
    const { userId, wagonData } = payload;
    const k = keyFor(userId);
    const prev = state[k] || { matchData: {}, overlays: {}, wagonData: [] };
    const nextWagon = Array.isArray(wagonData) ? wagonData : prev.wagonData;
    state[k] = {
      matchData: prev.matchData,
      overlays: prev.overlays,
      wagonData: nextWagon,
      updatedAt: new Date().toISOString()
    };
    // Optimize: if next is append-only extension of prev, emit only the tail
    const oldArr = Array.isArray(prev.wagonData) ? prev.wagonData : [];
    const newArr = Array.isArray(nextWagon) ? nextWagon : [];
    let isAppendOnly = newArr.length >= oldArr.length;
    if (isAppendOnly) {
      for (let i = 0; i < oldArr.length; i++) {
        if (JSON.stringify(oldArr[i]) !== JSON.stringify(newArr[i])) {
          isAppendOnly = false;
          break;
        }
      }
    }

    if (isAppendOnly && newArr.length > oldArr.length) {
      const tail = newArr.slice(oldArr.length);
      io.to(k).emit('wagon-append', { items: tail, startIndex: oldArr.length });
    } else {
      io.to(k).emit('wagon-update', { wagonData: newArr });
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Backend listening on ${PORT} (build: no-optional-route)`);
});
