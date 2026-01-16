const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

/**
 * ==========================================================
 * Mafia Game Rules (Your Final Rules)
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
 * - Detective investigates: 3 minutes (private result)
 *
 * Role reveal on death: YES
 * Win:
 * - Town wins if Mafia alive = 0
 * - Mafia wins if Mafia alive >= Town alive
 *
 * Host/Admin:
 * - Creates room and gets room code
 * - Host is NOT a player (no role, no vote, cannot die)
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
  DETECTIVE: 3 * 60,
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
  DETECTIVE: "DETECTIVE",
  ANNOUNCEMENT: "ANNOUNCEMENT",
  ENDED: "ENDED",
};

/**
 * Rooms are stored in memory:
 * rooms[roomCode] = roomObject
 */
const rooms = new Map();

/**
 * Generate room code like: A7K3Q
 */
function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
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

/**
 * Public state sent to all:
 * - Alive roles hidden
 * - Dead roles revealed
 */
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
  // Get all mafia names
  const mafiaNames = room.players
    .filter((p) => p.role === ROLES.MAFIA)
    .map((p) => p.name);

  room.players.forEach((p) => {
    // Send role to everyone privately
    io.to(p.id).emit("your_role", { role: p.role });

    // If player is mafia, also send mafia team list
    if (p.role === ROLES.MAFIA) {
      io.to(p.id).emit("mafia_team", { mafiaNames });
    }
  });
}

/**
 * Start phase + schedule next phase
 */
function startPhase(roomCode, phase, seconds) {
  const room = getRoom(roomCode);
  if (!room) return;

  room.phase = phase;
  room.phaseEndsAt = Date.now() + seconds * 1000;

  // Reset phase data
  if (phase === PHASES.DAY_VOTING) room.dayVotes = {};
  if (phase === PHASES.DOCTOR) room.night.doctorTargetId = null;
  if (phase === PHASES.MAFIA) room.night.mafiaVotes = {};
  if (phase === PHASES.DETECTIVE) room.night.detectiveTargetId = null;

  emitRoomState(roomCode);

  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => advancePhase(roomCode), seconds * 1000);
}

/**
 * Assign roles:
 * - Always 1 Doctor, 1 Detective
 * - Mafia count based on players
 */
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

/**
 * Resolve day voting:
 * - Highest votes eliminated
 * - Tie => no elimination
 */
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

/**
 * Resolve mafia majority vote:
 * - Tie => no kill
 */
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

/**
 * Resolve night kill with Doctor protection:
 * - Doctor protects FIRST
 * - Mafia kills AFTER
 * - If mafia target == protected => saved
 */
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

/**
 * Resolve detective privately:
 * - Detective sees Mafia / Not Mafia
 */
function resolveDetective(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;

  const detective = room.players.find((p) => p.alive && p.role === ROLES.DETECTIVE);
  if (!detective) return;

  const targetId = room.night.detectiveTargetId;
  if (!targetId) return;

  const target = room.players.find((p) => p.id === targetId);
  if (!target || !target.alive) return;

  const result = target.role === ROLES.MAFIA ? "MAFIA" : "NOT MAFIA";
  io.to(detective.id).emit("detective_result", { targetName: target.name, result });
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

/**
 * Game phase flow (state machine)
 */
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
      startPhase(roomCode, PHASES.DETECTIVE, SETTINGS.DETECTIVE);
      return;

    case PHASES.DETECTIVE:
      resolveDetective(roomCode);
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

/**
 * ==========================================================
 * SOCKET.IO EVENTS
 * ==========================================================
 */
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ==========================================================
  // CHAT SYSTEM (NEW)
  // ==========================================================

  /**
   * PUBLIC CHAT
   * Rule: ONLY ALIVE PLAYERS can send.
   * Everyone in room can read.
   */
  socket.on("public_chat", ({ roomCode, message }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return cb?.({ error: "Room not found." });

    const sender = room.players.find((p) => p.id === socket.id);

    // Host cannot send public chat
    if (!sender) return cb?.({ error: "Host cannot send public chat." });

    // Dead players cannot send public chat
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
   * MAFIA PRIVATE CHAT (ALWAYS ON)
   * Rule:
   * - Only alive Mafia can send
   * - Only alive Mafia can read
   */
  socket.on("mafia_chat", ({ roomCode, message }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return cb?.({ error: "Room not found." });

    const sender = room.players.find((p) => p.id === socket.id);

    // Host cannot use mafia chat
    if (!sender) return cb?.({ error: "Host cannot use mafia chat." });

    // Dead players cannot use mafia chat
    if (!sender.alive) return cb?.({ error: "Dead players cannot use mafia chat." });

    // Only Mafia can use mafia chat
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

  // ==========================================================
  // GAME EVENTS
  // ==========================================================

  // Host creates room (host is NOT a player)
  socket.on("create_room", ({ hostName }, cb) => {
    let roomCode = makeRoomCode();
    while (rooms.has(roomCode)) roomCode = makeRoomCode();

    const room = {
      roomCode,
      hostId: socket.id,
      hostName: hostName?.trim() || "Host",
      phase: PHASES.LOBBY,
      phaseEndsAt: null,
      round: 1,
      announcement: "Room created. Waiting for players...",
      timer: null,

      players: [], // ONLY PLAYERS
      dayVotes: {},
      night: {
        doctorTargetId: null,
        mafiaVotes: {},
        detectiveTargetId: null,
      },
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    cb({ roomCode });
    emitRoomState(roomCode);
  });

  // Player joins room
  socket.on("join_room", ({ roomCode, playerName }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });
    if (room.phase !== PHASES.LOBBY) return cb({ error: "Game already started." });

    room.players.push({
      id: socket.id,
      name: playerName?.trim() || "Player",
      role: null,
      alive: true,
    });

    socket.join(roomCode);
    cb({ ok: true });

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

  // Day vote by players
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

  // Mafia votes kill
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

  // Detective investigates
  socket.on("detective_check", ({ roomCode, targetId }, cb) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);

    if (!room) return cb({ error: "Room not found." });
    if (room.phase !== PHASES.DETECTIVE) return cb({ error: "Not Detective phase." });

    const detective = room.players.find((p) => p.id === socket.id);
    if (!detective || !detective.alive) return cb({ error: "You are not alive." });
    if (detective.role !== ROLES.DETECTIVE) return cb({ error: "You are not Detective." });

    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return cb({ error: "Target not alive." });

    room.night.detectiveTargetId = targetId;
    cb({ ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    // If host disconnects => end room
    for (const [roomCode, room] of rooms.entries()) {
      if (room.hostId === socket.id) {
        io.to(roomCode).emit("room_closed", { message: "Host disconnected. Room closed." });
        rooms.delete(roomCode);
        return;
      }
    }

    // If player disconnects => mark dead
    for (const [roomCode, room] of rooms.entries()) {
      const p = room.players.find((x) => x.id === socket.id);
      if (!p) continue;

      p.alive = false;
      room.announcement = `${p.name} disconnected and is removed. Role: ${p.role || "Unknown"}`;

      const winner = checkWin(room);
      if (winner) endGame(roomCode, winner);

      emitRoomState(roomCode);
    }
  });
});

/**
 * IMPORTANT for Render hosting:
 * Must use process.env.PORT
 */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Mafia server running on port:", PORT);
});
