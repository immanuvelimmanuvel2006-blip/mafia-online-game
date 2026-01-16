const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

/**
 * ==========================================================
 * Mafia Game Rules
 * ==========================================================
 * Roles:
 * - Town
 * - Mafia
 * - Doctor
 * - Detective
 *
 * Day:
 * - Discussion: 12 minutes
 * - Voting: 3 minutes (tie => no elimination)
 *
 * Night:
 * - Sleep: 1 minute
 * - Doctor protects: 2 minutes
 * - Mafia kills: 3 minutes (mafia vote, majority wins, tie => no kill)
 * - Execution: 3 minutes (system resolves kill)
 *
 * Detective (UPDATED RULE):
 * - Detective investigates 1 person per FULL DAY
 * - Allowed during DAY_DISCUSSION or DAY_VOTING
 * - Only 1 check per day (private result)
 *
 * Role reveal on death: YES
 * Win:
 * - Town wins if Mafia alive = 0
 * - Mafia wins if Mafia alive >= Town alive
 *
 * Host/Admin:
 * - Creates room and gets room code
 * - Host is NOT a player (no role, no vote, cannot die)
 *
 * Refresh reconnect (UPDATED):
 * - Host + players get a token
 * - On refresh, client sends token -> server restores same session
 */

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve frontend files
app.use(express.static("public"));

/**
 * Timers in seconds
 */
const SETTINGS = {
  DAY_DISCUSSION: 12 * 60,
  DAY_VOTING: 3 * 60,
  SLEEP: 60,
  DOCTOR: 2 * 60,
  MAFIA: 3 * 60,
  EXECUTION: 3 * 60,
  ANNOUNCEMENT: 15,
};

const ROLES = {
  TOWN: "TOWN",
  MAFIA: "MAFIA",
  DOCTOR: "DOCTOR",
  DETECTIVE: "DETECTIVE",
};

const PHASES = {
  LOBBY: "LOBBY",
  DAY_DISCUSSION: "DAY_DISCUSSION",
  DAY_VOTING: "DAY_VOTING",
  SLEEP: "SLEEP",
  DOCTOR: "DOCTOR",
  MAFIA: "MAFIA",
  EXECUTION: "EXECUTION",
  ANNOUNCEMENT: "ANNOUNCEMENT",
  ENDED: "ENDED",
};

const rooms = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function makeToken() {
  return (
    Math.random().toString(36).slice(2) +
    "-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Date.now()
  );
}

function getRoom(roomCode) {
  return rooms.get(roomCode);
}

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function aliveCounts(room) {
  const alive = alivePlayers(room);
  const mafia = alive.filter((p) => p.role === ROLES.MAFIA).length;
  const town = alive.length - mafia;
  return { mafia, town };
}

function checkWin(room) {
  const { mafia, town } = aliveCounts(room);
  if (mafia === 0) return "TOWN";
  if (mafia >= town) return "MAFIA";
  return null;
}

function emitRoomState(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  const publicPlayers = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    revealedRole: p.alive ? null : p.role,
  }));

  io.to(roomCode).emit("room_state", {
    roomCode,
    hostId: room.hostId,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    round: room.round,
    announcement: room.announcement,
    players: publicPlayers,
  });
}

function sendPrivateRoles(room) {
  const mafiaNames = room.players
    .filter((p) => p.role === ROLES.MAFIA)
    .map((p) => p.name);

  room.players.forEach((p) => {
    io.to(p.id).emit("your_role", { role: p.role });

    if (p.role === ROLES.MAFIA) {
      io.to(p.id).emit("mafia_team", { mafiaNames });
    }
  });
}

function startPhase(roomCode, phase, seconds) {
  const room = getRoom(roomCode);
  if (!room) return;

  room.phase = phase;
  room.phaseEndsAt = Date.now() + seconds * 1000;

  // Reset phase data
  if (phase === PHASES.DAY_VOTING) room.dayVotes = {};
  if (phase === PHASES.DOCTOR) room.night.doctorTargetId = null;
  if (phase === PHASES.MAFIA) room.night.mafiaVotes = {};

  // Reset detective usage every new day
  if (phase === PHASES.DAY_DISCUSSION) {
    room.dayDetectiveUsed = false;
    room.dayDetectiveTargetId = null;
  }

  emitRoomState(roomCode);

  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => advancePhase(roomCode), seconds * 1000);
}

function assignRoles(room) {
  const n = room.players.length;

  let mafiaCount = 2;
  if (n >= 9 && n <= 12) mafiaCount = 3;
  if (n >= 13) mafiaCount = 4;

  const roles = [];
  roles.push(ROLES.DOCTOR);
  roles.push(ROLES.DETECTIVE);
  for (let i = 0; i < mafiaCount; i++) roles.push(ROLES.MAFIA);
  while (roles.length < n) roles.push(ROLES.TOWN);

  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  room.players.forEach((p, idx) => {
    p.role = roles[idx];
    p.alive = true;
  });
}

function resolveDayVoting(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  const alive = alivePlayers(room);
  const counts = new Map();

  for (const voterId in room.dayVotes) {
    const targetId = room.dayVotes[voterId];

    const voter = alive.find((p) => p.id === voterId);
    const target = alive.find((p) => p.id === targetId);

    if (!voter || !target) continue;
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }

  let bestTargetId = null;
  let bestCount = 0;
  let tie = false;

  for (const [targetId, c] of counts.entries()) {
    if (c > bestCount) {
      bestCount = c;
      bestTargetId = targetId;
      tie = false;
    } else if (c === bestCount && c > 0) {
      tie = true;
    }
  }

  if (!bestTargetId || bestCount === 0 || tie) {
    room.announcement = "Voting ended: No one was eliminated (tie or no votes).";
    return;
  }

  const eliminated = room.players.find((p) => p.id === bestTargetId);
  if (eliminated && eliminated.alive) {
    eliminated.alive = false;
    room.announcement = `Voting result: ${eliminated.name} eliminated. Role: ${eliminated.role}`;
  }

  const winner = checkWin(room);
  if (winner) endGame(roomCode, winner);
}

function resolveMafiaKillTarget(room) {
  const alive = alivePlayers(room);
  const mafiaAlive = alive.filter((p) => p.role === ROLES.MAFIA);

  const counts = new Map();

  for (const mafiaId in room.night.mafiaVotes) {
    const targetId = room.night.mafiaVotes[mafiaId];

    const voter = mafiaAlive.find((p) => p.id === mafiaId);
    const target = alive.find((p) => p.id === targetId);

    if (!voter || !target) continue;
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }

  let bestTargetId = null;
  let bestCount = 0;
  let tie = false;

  for (const [targetId, c] of counts.entries()) {
    if (c > bestCount) {
      bestCount = c;
      bestTargetId = targetId;
      tie = false;
    } else if (c === bestCount && c > 0) {
      tie = true;
    }
  }

  if (!bestTargetId || bestCount === 0 || tie) return null;
  return bestTargetId;
}

function resolveNightKill(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  const mafiaTargetId = resolveMafiaKillTarget(room);

  if (!mafiaTargetId) {
    room.announcement = "Night result: Mafia did not finalize a kill. No one died.";
    return;
  }

  const target = room.players.find((p) => p.id === mafiaTargetId);
  if (!target || !target.alive) {
    room.announcement = "Night result: Invalid target. No one died.";
    return;
  }

  if (room.night.doctorTargetId && room.night.doctorTargetId === mafiaTargetId) {
    room.announcement = `Night result: ${target.name} was attacked but saved by Doctor.`;
    return;
  }

  target.alive = false;
  room.announcement = `Night result: ${target.name} was killed. Role: ${target.role}`;

  const winner = checkWin(room);
  if (winner) endGame(roomCode, winner);
}

function endGame(roomCode, winner) {
  const room = getRoom(roomCode);
  if (!room) return;

  room.phase = PHASES.ENDED;
  room.phaseEndsAt = null;

  if (room.timer) clearTimeout(room.timer);

  room.announcement = `GAME OVER. Winner: ${winner}`;

  io.to(roomCode).emit("game_over", {
    winner,
    finalRoles: room.players.map((p) => ({
      name: p.name,
      role: p.role,
      alive: p.alive,
    })),
  });

  emitRoomState(roomCode);
}

function advancePhase(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;
  if (room.phase === PHASES.ENDED) return;

  switch (room.phase) {
    case PHASES.LOBBY:
      return;

    case PHASES.DAY_DISCUSSION:
      startPhase(roomCode, PHASES.DAY_VOTING, SETTINGS.DAY_VOTING);
      return;

    case PHASES.DAY_VOTING:
      resolveDayVoting(roomCode);
      if (room.phase === PHASES.ENDED) return;
      startPhase(roomCode, PHASES.SLEEP, SETTINGS.SLEEP);
      return;

    case PHASES.SLEEP:
      startPhase(roomCode, PHASES.DOCTOR, SETTINGS.DOCTOR);
      return;

    case PHASES.DOCTOR:
      startPhase(roomCode, PHASES.MAFIA, SETTINGS.MAFIA);
      return;

    case PHASES.MAFIA:
      startPhase(roomCode, PHASES.EXECUTION, SETTINGS.EXECUTION);
      return;

    case PHASES.EXECUTION:
      resolveNightKill(roomCode);
      if (room.phase === PHASES.ENDED) return;
      startPhase(roomCode, PHASES.ANNOUNCEMENT, SETTINGS.ANNOUNCEMENT);
      return;

    case PHASES.ANNOUNCEMENT:
      room.round += 1;
      startPhase(roomCode, PHASES.DAY_DISCUSSION, SETTINGS.DAY_DISCUSSION);
      return;

    default:
      return;
  }
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // =========================
  // RESTORE SESSION (NEW)
  // =========================
  socket.on("restore_session", ({ roomCode, token }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    token = String(token || "").trim();

    const room = getRoom(roomCode);
    if (!room) return cb?.({ error: "Room not found." });
    if (!token) return cb?.({ error: "Invalid token." });

    // Restore host
    if (room.hostToken === token) {
      const oldHostId = room.hostId;

      // Move host to new socket id
      room.hostId = socket.id;

      // Join socket to room
      socket.join(roomCode);

      // Update state
      emitRoomState(roomCode);

      return cb?.({ ok: true, roomCode });
    }

    // Restore player
    const player = room.players.find((p) => p.token === token);
    if (!player) return cb?.({ error: "Session not found." });

    const oldId = player.id;
    player.id = socket.id;

    socket.join(roomCode);

    // Send role again
    io.to(player.id).emit("your_role", { role: player.role });

    // If mafia, resend mafia team list
    if (player.role === ROLES.MAFIA) {
      const mafiaNames = room.players
        .filter((p) => p.role === ROLES.MAFIA)
        .map((p) => p.name);
      io.to(player.id).emit("mafia_team", { mafiaNames });
    }

    emitRoomState(roomCode);
    cb?.({ ok: true, roomCode });
  });

  /**
   * PUBLIC CHAT
   * Only alive players can send.
   */
  socket.on("public_chat", ({ roomCode, message }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return cb?.({ error: "Room not found." });

    const sender = room.players.find((p) => p.id === socket.id);

    if (!sender) return cb?.({ error: "Host cannot send public chat." });
    if (!sender.alive) return cb?.({ error: "Dead players cannot send public chat." });

    const text = String(message || "").trim();
    if (!text) return cb?.({ error: "Empty message." });

    io.to(roomCode).emit("public_chat_message", {
      senderName: sender.name,
      message: text,
      time: new Date().toLocaleTimeString(),
    });

    cb?.({ ok: true });
  });

  /**
   * MAFIA PRIVATE CHAT
   * Only alive Mafia can send, only alive Mafia can read.
   */
  socket.on("mafia_chat", ({ roomCode, message }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return cb?.({ error: "Room not found." });

    const sender = room.players.find((p) => p.id === socket.id);

    if (!sender) return cb?.({ error: "Host cannot use mafia chat." });
    if (!sender.alive) return cb?.({ error: "Dead players cannot use mafia chat." });
    if (sender.role !== ROLES.MAFIA) return cb?.({ error: "Only Mafia can use mafia chat." });

    const text = String(message || "").trim();
    if (!text) return cb?.({ error: "Empty message." });

    const aliveMafia = room.players.filter((p) => p.alive && p.role === ROLES.MAFIA);

    aliveMafia.forEach((m) => {
      io.to(m.id).emit("mafia_chat_message", {
        senderName: sender.name,
        message: text,
        time: new Date().toLocaleTimeString(),
      });
    });

    cb?.({ ok: true });
  });

  // Host creates room
  socket.on("create_room", ({ hostName }, cb) => {
    let roomCode = makeRoomCode();
    while (rooms.has(roomCode)) roomCode = makeRoomCode();

    const hostToken = makeToken();

    const room = {
      roomCode,
      hostId: socket.id,
      hostToken,
      hostName: hostName?.trim() || "Host",
      phase: PHASES.LOBBY,
      phaseEndsAt: null,
      round: 1,
      announcement: "Room created. Waiting for players...",
      timer: null,

      players: [],
      dayVotes: {},
      dayDetectiveUsed: false,
      dayDetectiveTargetId: null,

      night: {
        doctorTargetId: null,
        mafiaVotes: {},
      },
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    cb({ roomCode, token: hostToken });
    emitRoomState(roomCode);
  });

  // Player joins room
  socket.on("join_room", ({ roomCode, playerName }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });
    if (room.phase !== PHASES.LOBBY) return cb({ error: "Game already started." });

    const token = makeToken();

    room.players.push({
      id: socket.id,
      token,
      name: playerName?.trim() || "Player",
      role: null,
      alive: true,
    });

    socket.join(roomCode);
    cb({ ok: true, token });

    emitRoomState(roomCode);
  });

  // Host starts game
  socket.on("start_game", ({ roomCode }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });
    if (socket.id !== room.hostId) return cb({ error: "Only host can start." });

    if (room.players.length < 6) {
      return cb({ error: "Minimum 6 players required." });
    }

    assignRoles(room);
    sendPrivateRoles(room);

    room.announcement = "Game started. Day Discussion begins (12 minutes).";
    startPhase(roomCode, PHASES.DAY_DISCUSSION, SETTINGS.DAY_DISCUSSION);

    cb({ ok: true });
  });

  // Day vote
  socket.on("cast_vote", ({ roomCode, targetId }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });
    if (room.phase !== PHASES.DAY_VOTING) return cb({ error: "Not voting phase." });

    const voter = room.players.find((p) => p.id === socket.id);
    const target = room.players.find((p) => p.id === targetId);

    if (!voter || !voter.alive) return cb({ error: "You are not alive." });
    if (!target || !target.alive) return cb({ error: "Target not alive." });

    room.dayVotes[socket.id] = targetId;
    cb({ ok: true });

    emitRoomState(roomCode);
  });

  // Doctor protects
  socket.on("doctor_protect", ({ roomCode, targetId }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });
    if (room.phase !== PHASES.DOCTOR) return cb({ error: "Not Doctor phase." });

    const doctor = room.players.find((p) => p.id === socket.id);
    if (!doctor || !doctor.alive) return cb({ error: "You are not alive." });
    if (doctor.role !== ROLES.DOCTOR) return cb({ error: "You are not Doctor." });

    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return cb({ error: "Target not alive." });

    room.night.doctorTargetId = targetId;
    cb({ ok: true });
  });

  // Mafia vote kill
  socket.on("mafia_vote_kill", ({ roomCode, targetId }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });
    if (room.phase !== PHASES.MAFIA) return cb({ error: "Not Mafia phase." });

    const mafia = room.players.find((p) => p.id === socket.id);
    if (!mafia || !mafia.alive) return cb({ error: "You are not alive." });
    if (mafia.role !== ROLES.MAFIA) return cb({ error: "You are not Mafia." });

    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return cb({ error: "Target not alive." });

    room.night.mafiaVotes[socket.id] = targetId;
    cb({ ok: true });
  });

  // Detective check (FULL DAY, 1 per day)
  socket.on("detective_check", ({ roomCode, targetId }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });

    // Allowed only during full day
    if (room.phase !== PHASES.DAY_DISCUSSION && room.phase !== PHASES.DAY_VOTING) {
      return cb({ error: "Detective can investigate only during the day." });
    }

    const detective = room.players.find((p) => p.id === socket.id);
    if (!detective || !detective.alive) return cb({ error: "You are not alive." });
    if (detective.role !== ROLES.DETECTIVE) return cb({ error: "You are not Detective." });

    if (room.dayDetectiveUsed) {
      return cb({ error: "You already used investigation today." });
    }

    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return cb({ error: "Target not alive." });

    room.dayDetectiveUsed = true;
    room.dayDetectiveTargetId = targetId;

    const result = target.role === ROLES.MAFIA ? "MAFIA" : "NOT MAFIA";
    io.to(detective.id).emit("detective_result", { targetName: target.name, result });

    cb({ ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    // If host disconnects -> DO NOT close room immediately (refresh safe)
    // We only close room if host never reconnects, but for now keep it alive.
    for (const [roomCode, room] of rooms.entries()) {
      if (room.hostId === socket.id) {
        // Mark host as offline (optional)
        room.hostId = null;
        emitRoomState(roomCode);
        return;
      }
    }

    // If player disconnects -> DO NOT kill player immediately (refresh safe)
    // Keep them alive, they can restore session with token.
    // If you want strict rule, we can add timeout later.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Mafia server running on port:", PORT);
});
