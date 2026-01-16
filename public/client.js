const socket = io();

let myRoomCode = null;
let myRole = "HOST / Unknown";
let lastState = null;

const el = (id) => document.getElementById(id);

const authBox = el("authBox");
const gameBox = el("gameBox");
const finalBox = el("finalBox");

const roomCodeEl = el("roomCode");
const roundEl = el("round");
const phaseEl = el("phase");
const timerEl = el("timer");
const announcementEl = el("announcement");

const myRoleEl = el("myRole");
const detectiveResultEl = el("detectiveResult");

const playersListEl = el("playersList");

const actionBox = el("actionBox");
const actionTextEl = el("actionText");
const targetsEl = el("targets");

const startBtn = el("startBtn");

// =========================
// CHAT ELEMENTS (NEW)
// =========================
const publicChatMessages = el("publicChatMessages");
const publicChatInput = el("publicChatInput");
const publicChatSendBtn = el("publicChatSendBtn");

const mafiaChatBox = el("mafiaChatBox");
const mafiaChatMessages = el("mafiaChatMessages");
const mafiaChatInput = el("mafiaChatInput");
const mafiaChatSendBtn = el("mafiaChatSendBtn");

function show(elem, yes) {
  elem.classList.toggle("hidden", !yes);
}

function secondsToMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function addChatMessage(container, senderName, message, time) {
  const div = document.createElement("div");
  div.className = "chatMsg";
  div.innerHTML = `<b>${senderName}</b> <span class="small">(${time})</span><br/>${message}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function renderPlayers(players) {
  playersListEl.innerHTML = "";

  players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player" + (p.alive ? "" : " dead");
    div.innerHTML = `
      <div><b>${p.name}</b> ${p.alive ? "" : "(DEAD)"}</div>
      <div class="small">Role: ${p.revealedRole ? p.revealedRole : "Hidden"}</div>
    `;
    playersListEl.appendChild(div);
  });
}

function clearActionUI() {
  show(actionBox, false);
  actionTextEl.innerText = "";
  targetsEl.innerHTML = "";
}

function renderActionUI(state) {
  clearActionUI();
  if (!state) return;

  // Find if I'm a player
  const me = state.players.find((p) => p.id === socket.id);

  // Host is not a player => host has no action panel
  if (!me) return;

  // Dead players can't act
  if (!me.alive) return;

  const alivePlayers = state.players.filter((p) => p.alive);

  // Day voting for all alive players
  if (state.phase === "DAY_VOTING") {
    show(actionBox, true);
    actionTextEl.innerText = "Voting time (3 minutes): vote one player to eliminate.";

    alivePlayers.forEach((p) => {
      const btn = document.createElement("button");
      btn.innerText = `Vote: ${p.name}`;
      btn.onclick = () => {
        socket.emit("cast_vote", { roomCode: myRoomCode, targetId: p.id }, (res) => {
          if (res?.error) alert(res.error);
          else alert("Vote submitted.");
        });
      };
      targetsEl.appendChild(btn);
    });
    return;
  }

  // Doctor action
  if (state.phase === "DOCTOR" && myRole === "DOCTOR") {
    show(actionBox, true);
    actionTextEl.innerText = "Doctor (2 minutes): select one player to protect.";

    alivePlayers.forEach((p) => {
      const btn = document.createElement("button");
      btn.innerText = `Protect: ${p.name}`;
      btn.onclick = () => {
        socket.emit("doctor_protect", { roomCode: myRoomCode, targetId: p.id }, (res) => {
          if (res?.error) alert(res.error);
          else alert("Protection selected.");
        });
      };
      targetsEl.appendChild(btn);
    });
    return;
  }

  // Mafia vote kill
  if (state.phase === "MAFIA" && myRole === "MAFIA") {
    show(actionBox, true);
    actionTextEl.innerText =
      "Mafia (3 minutes): vote one player to kill (majority wins, tie = no kill).";

    alivePlayers.forEach((p) => {
      const btn = document.createElement("button");
      btn.innerText = `Vote Kill: ${p.name}`;
      btn.onclick = () => {
        socket.emit("mafia_vote_kill", { roomCode: myRoomCode, targetId: p.id }, (res) => {
          if (res?.error) alert(res.error);
          else alert("Mafia vote submitted.");
        });
      };
      targetsEl.appendChild(btn);
    });
    return;
  }

  // Detective action
  if (state.phase === "DETECTIVE" && myRole === "DETECTIVE") {
    show(actionBox, true);
    actionTextEl.innerText = "Detective (3 minutes): investigate one player.";

    alivePlayers.forEach((p) => {
      const btn = document.createElement("button");
      btn.innerText = `Investigate: ${p.name}`;
      btn.onclick = () => {
        socket.emit("detective_check", { roomCode: myRoomCode, targetId: p.id }, (res) => {
          if (res?.error) alert(res.error);
          else alert("Investigation selected.");
        });
      };
      targetsEl.appendChild(btn);
    });
    return;
  }
}

function renderState(state) {
  lastState = state;

  roomCodeEl.innerText = state.roomCode;
  roundEl.innerText = state.round;
  phaseEl.innerText = state.phase;
  announcementEl.innerText = state.announcement || "-";

  renderPlayers(state.players);
  renderActionUI(state);

  // Show Start button only for host in lobby
  const amHost = state.hostId === socket.id;
  show(startBtn, amHost && state.phase === "LOBBY");

  show(authBox, false);
  show(gameBox, true);
}

// Timer display
setInterval(() => {
  if (!lastState || !lastState.phaseEndsAt) {
    timerEl.innerText = "-";
    return;
  }
  const leftMs = lastState.phaseEndsAt - Date.now();
  const leftSec = Math.max(0, Math.floor(leftMs / 1000));
  timerEl.innerText = secondsToMMSS(leftSec);
}, 250);

// =========================
// CHAT SEND BUTTONS
// =========================

// Public chat send
publicChatSendBtn.onclick = () => {
  const msg = publicChatInput.value.trim();
  if (!msg) return;

  socket.emit("public_chat", { roomCode: myRoomCode, message: msg }, (res) => {
    if (res?.error) alert(res.error);
    else publicChatInput.value = "";
  });
};

publicChatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") publicChatSendBtn.click();
});

// Mafia chat send
mafiaChatSendBtn.onclick = () => {
  const msg = mafiaChatInput.value.trim();
  if (!msg) return;

  socket.emit("mafia_chat", { roomCode: myRoomCode, message: msg }, (res) => {
    if (res?.error) alert(res.error);
    else mafiaChatInput.value = "";
  });
};

mafiaChatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") mafiaChatSendBtn.click();
});

// Create room (Host)
el("createRoomBtn").onclick = () => {
  const hostName = el("hostNameInput").value.trim() || "Host";
  socket.emit("create_room", { hostName }, (res) => {
    myRoomCode = res.roomCode;
    alert("Room created. Code: " + myRoomCode);
  });
};

// Join room (Player)
el("joinRoomBtn").onclick = () => {
  const playerName = el("playerNameInput").value.trim() || "Player";
  const roomCode = el("roomCodeInput").value.trim().toUpperCase();

  socket.emit("join_room", { roomCode, playerName }, (res) => {
    if (res?.error) alert(res.error);
    else {
      myRoomCode = roomCode;
      alert("Joined room: " + roomCode);
    }
  });
};

// Start game (Host)
startBtn.onclick = () => {
  socket.emit("start_game", { roomCode: myRoomCode }, (res) => {
    if (res?.error) alert(res.error);
  });
};

// Events from server
socket.on("room_state", (state) => {
  renderState(state);
});

socket.on("your_role", ({ role }) => {
  myRole = role;
  myRoleEl.innerText = role;

  // Mafia chat visible only for mafia
  show(mafiaChatBox, myRole === "MAFIA");
});

socket.on("mafia_team", ({ mafiaNames }) => {
  // Show mafia list only to mafia player
  detectiveResultEl.innerText = "Mafia team: " + mafiaNames.join(", ");
});

socket.on("detective_result", ({ targetName, result }) => {
  detectiveResultEl.innerText = `Detective result: ${targetName} = ${result}`;
});

// Chat receive events
socket.on("public_chat_message", ({ senderName, message, time }) => {
  addChatMessage(publicChatMessages, senderName, message, time);
});

socket.on("mafia_chat_message", ({ senderName, message, time }) => {
  addChatMessage(mafiaChatMessages, senderName, message, time);
});

socket.on("game_over", ({ winner, finalRoles }) => {
  show(finalBox, true);
  el("winnerText").innerText = "Winner: " + winner;

  const box = el("finalRoles");
  box.innerHTML = "";
  finalRoles.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player";
    div.innerHTML = `<b>${p.name}</b> — ${p.role} — ${p.alive ? "ALIVE" : "DEAD"}`;
    box.appendChild(div);
  });
});

socket.on("room_closed", ({ message }) => {
  alert(message);
  location.reload();
});
