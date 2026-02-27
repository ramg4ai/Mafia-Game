const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Game State Storage
// ─────────────────────────────────────────────────────────────────────────────

const rooms = {}; // roomCode → gameState

// ─────────────────────────────────────────────────────────────────────────────
// Role & Group Definitions
// ─────────────────────────────────────────────────────────────────────────────

const ROLES = {
  MAFIA: { name: 'Mafia', group: 'mafia', special: false },
  TRAITOR: { name: 'Traitor', group: 'mafia', special: true },
  DOCTOR: { name: 'Doctor', group: 'civilian', special: false },
  POLICE: { name: 'Police', group: 'civilian', special: false },
  VIGILANTE: { name: 'Vigilante', group: 'civilian', special: true },
  JESTER: { name: 'Jester', group: 'neutral', special: true },
  JOKER: { name: 'Joker', group: 'neutral', special: false },
  CIVILIAN: { name: 'Civilian', group: 'civilian', special: false },
};

// Night phase action order (role names)
const NIGHT_ORDER = ['MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JOKER', 'JESTER', 'CIVILIAN'];

// Night actors — which roles actually DO something at night
const NIGHT_ACTORS = new Set(['MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JOKER']);

// ─────────────────────────────────────────────────────────────────────────────
// Role Assignment Logic
// ─────────────────────────────────────────────────────────────────────────────

function assignRoles(playerCount) {
  let roles = [];

  if (playerCount === 6) {
    roles = ['MAFIA', 'MAFIA', 'DOCTOR', 'POLICE', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 7) {
    roles = ['MAFIA', 'MAFIA', 'DOCTOR', 'POLICE', 'CIVILIAN', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 8) {
    roles = ['MAFIA', 'MAFIA', 'MAFIA', 'DOCTOR', 'POLICE', 'CIVILIAN', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 9) {
    // 1 mandatory special Mafia role (Traitor)
    roles = ['MAFIA', 'MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'CIVILIAN', 'CIVILIAN', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 10) {
    // 1 mandatory special from each group: Traitor (mafia), Vigilante (civilian), Jester (neutral)
    roles = ['MAFIA', 'MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'CIVILIAN', 'CIVILIAN', 'JOKER', 'JESTER'];
  }

  // Shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Win Condition Checker
// ─────────────────────────────────────────────────────────────────────────────

function checkWinCondition(room) {
  const alivePlayers = room.players.filter(p => p.alive);
  const aliveCount = alivePlayers.length;

  const mafiaAlive = alivePlayers.filter(p => ROLES[p.role].group === 'mafia');
  const civilianAlive = alivePlayers.filter(p => ROLES[p.role].group === 'civilian');
  const neutralAlive = alivePlayers.filter(p => ROLES[p.role].group === 'neutral');
  const jokerAlive = alivePlayers.find(p => p.role === 'JOKER');

  // 2-player endings
  if (aliveCount === 2) {
    const roles = alivePlayers.map(p => p.role);
    const has = (r) => roles.includes(r);

    if (mafiaAlive.length >= 1 && civilianAlive.length >= 1) return { winner: 'Mafia', reason: 'Mafia outnumbers Civilians' };
    if (mafiaAlive.length >= 1 && jokerAlive) return { winner: 'Mafia', reason: 'Mafia and Joker remain' };
    if (has('MAFIA') && has('VIGILANTE')) return { winner: null, reason: 'Mutual destruction — no one wins' };
    if (has('MAFIA') && has('JESTER')) return { winner: 'Mafia', reason: 'Mafia and Jester remain' };
    if (civilianAlive.length >= 1 && jokerAlive) return { winner: 'Civilians', reason: 'Civilian and Joker remain' };
    if (civilianAlive.length >= 1 && has('JESTER')) return { winner: 'Civilians', reason: 'Civilian and Jester remain' };
  }

  // 3-player endings
  if (aliveCount === 3) {
    if (mafiaAlive.length === 2 && civilianAlive.length === 1 && neutralAlive.length === 0) {
      return { winner: 'Mafia', reason: '2 Mafia vs 1 Civilian' };
    }
  }

  // General endings
  if (mafiaAlive.length === 0 && neutralAlive.length === 0) return { winner: 'Civilians', reason: 'All Mafia eliminated' };
  if (mafiaAlive.length === 0 && civilianAlive.length === 0) return { winner: 'Neutrals', reason: 'Only neutrals remain' };
  if (civilianAlive.length === 0 && neutralAlive.length === 0) return { winner: 'Mafia', reason: 'All Civilians eliminated' };

  // Joker conditions
  if (jokerAlive) {
    if (mafiaAlive.length === 0 && civilianAlive.length === 0) return { winner: 'Neutrals', reason: 'Only Neutrals remain' };
    if (civilianAlive.length === 0 && mafiaAlive.length > 0 && neutralAlive.every(p => p.role !== 'JESTER')) return { winner: 'Mafia', reason: 'Joker sides with Mafia' };
    if (mafiaAlive.length === 0 && civilianAlive.length > 0) return { winner: 'Civilians', reason: 'Joker sides with Civilians' };
  }

  // Mafia majority: if mafia >= all others they effectively win
  if (mafiaAlive.length >= (civilianAlive.length + neutralAlive.length) && mafiaAlive.length > 0 && (civilianAlive.length + neutralAlive.length) > 0) {
    return { winner: 'Mafia', reason: 'Mafia outnumbers remaining players' };
  }

  return null; // game continues
}

// ─────────────────────────────────────────────────────────────────────────────
// Night Phase Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getNextNightActor(room) {
  for (const roleKey of NIGHT_ORDER) {
    if (room.nightActed.has(roleKey)) continue;
    if (!NIGHT_ACTORS.has(roleKey)) continue;

    if (roleKey === 'MAFIA' || roleKey === 'TRAITOR') {
      // Mafia & Traitor act together as a group
      const mafiaAlive = room.players.filter(p => ROLES[p.role].group === 'mafia' && p.alive);
      const mafiaDead = room.players.filter(p => ROLES[p.role].group === 'mafia' && !p.alive);
      if (!room.nightActed.has('MAFIA_GROUP')) {
        room.nightActed.add('MAFIA_GROUP');
        if (mafiaAlive.length > 0) {
          return { role: 'MAFIA_GROUP', players: mafiaAlive, isGhost: false };
        } else if (mafiaDead.length > 0) {
          return { role: 'MAFIA_GROUP', players: mafiaDead, isGhost: true };
        }
      }
    } else {
      const aliveActor = room.players.find(p => p.role === roleKey && p.alive);
      if (aliveActor) {
        room.nightActed.add(roleKey);
        return { role: roleKey, players: [aliveActor], isGhost: false };
      }
      const deadActor = room.players.find(p => p.role === roleKey && !p.alive);
      if (deadActor) {
        room.nightActed.add(roleKey);
        return { role: roleKey, players: [deadActor], isGhost: true };
      }
    }
  }
  return null; // all actors done
}

// Returns the kill target id if there is a clear majority, null on tie or no votes.
function resolveMafiaVotes(mafiaVotes) {
  const votes = Object.values(mafiaVotes);
  if (votes.length === 0) return null; // nobody voted

  const tally = {};
  for (const v of votes) tally[v] = (tally[v] || 0) + 1;

  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  // Clear majority = top candidate is strictly ahead of second place
  if (sorted.length === 1 || sorted[0][1] > sorted[1][1]) {
    return sorted[0][0]; // unambiguous winner
  }
  return null; // tie — no kill
}

function resolveNightActions(room) {
  const events = [];

  // Process kill flags from Mafia vote
  if (room.nightActions.mafiaKill) {
    const target = room.players.find(p => p.id === room.nightActions.mafiaKill);
    if (target) target.killFlagged = true;
  }

  // Doctor saves
  if (room.nightActions.doctorSave) {
    const target = room.players.find(p => p.id === room.nightActions.doctorSave);
    if (target && target.killFlagged) {
      target.killFlagged = false;
    }
  }

  // Joker actions
  if (room.nightActions.jokerAction) {
    const { action, targetId } = room.nightActions.jokerAction;
    const target = room.players.find(p => p.id === targetId);
    if (target) {
      if (action === 'kill') {
        target.killFlagged = true;
      } else if (action === 'protect') {
        if (target.killFlagged) {
          target.killFlagged = false;
          events.push({ type: 'save', message: 'The Joker protected someone tonight!' });
        }
      }
      // investigate is handled at action time
    }
  }

  // Vigilante kill
  if (room.nightActions.vigilanteKill) {
    const targetId = room.nightActions.vigilanteKill;
    const target = room.players.find(p => p.id === targetId);
    const vigilante = room.players.find(p => p.role === 'VIGILANTE' && p.alive);
    if (target && vigilante) {
      if (ROLES[target.role].group === 'civilian') {
        // Vigilante dies instead
        vigilante.killFlagged = true;
      } else {
        target.killFlagged = true;
      }
    }
  }

  // Eliminate kill-flagged players
  const eliminated = [];
  for (const player of room.players) {
    if (player.killFlagged) {
      player.alive = false;
      player.killFlagged = false;
      eliminated.push(player.name);

      // Remove from mafia chat if applicable
      if (ROLES[player.role].group === 'mafia') {
        io.sockets.sockets.get(player.id)?.leave(`mafia-${room.code}`);
      }
    }
  }

  // Score ghost guesses
  const correctGuessers = [];
  for (const [playerId, targetId] of Object.entries(room.ghostGuesses)) {
    const guesser = room.players.find(p => p.id === playerId);
    if (!guesser) continue;
    const correct =
      (targetId === 'none' && eliminated.length === 0) ||
      (targetId !== 'none' && eliminated.some(name => {
        const target = room.players.find(p => p.id === targetId);
        return target && target.name === name;
      }));
    if (correct) correctGuessers.push(guesser.name);
  }

  return { eliminated, events, correctGuessers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Night Turn Timer
// ─────────────────────────────────────────────────────────────────────────────

function startNightTurn(room) {
  clearTimeout(room.nightTimer);

  const current = getNextNightActor(room);

  if (!current) {
    // All night actors done → resolve and start day
    const { eliminated, events, correctGuessers } = resolveNightActions(room);
    room.phase = 'day-start';

    io.to(room.code).emit('night-resolved', { eliminated, events, correctGuessers });

    const winResult = checkWinCondition(room);
    if (winResult) {
      return endGame(room, winResult);
    }

    // Start day phase after a short delay
    setTimeout(() => startDayPhase(room), 6000);
    return;
  }

  // Tell all clients whose turn it is (same message regardless of ghost/alive)
  io.to(room.code).emit('night-turn', {
    role: current.role,
    actorNames: current.players.map(p => p.name),
    timeLeft: room.nightPhaseSeconds,
  });

  if (current.isGhost) {
    // ── Ghost turn: dead role player gets guessing panel, not action panel ──
    const alivePlayers = room.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name }));
    for (const player of current.players) {
      const sock = io.sockets.sockets.get(player.id);
      if (sock) sock.emit('ghost-night-turn', { alivePlayers, timeLeft: room.nightPhaseSeconds });
    }

    room.nightTimer = setTimeout(() => {
      // Ghost timer expired — advance silently (no skip log)
      io.to(room.code).emit('night-turn-done', { role: current.role });
      startNightTurn(room);
    }, (room.nightPhaseSeconds + 1) * 1000);

  } else {
    // ── Normal alive turn: send action prompt to actor(s) ──
    for (const player of current.players) {
      const sock = io.sockets.sockets.get(player.id);
      if (sock) {
        const canTargetSelf = current.role === 'DOCTOR' || current.role === 'JOKER';
        const targets = room.players
          .filter(p => {
            if (!p.alive) return false;
            if (current.role === 'MAFIA_GROUP' && ROLES[p.role].group === 'mafia') return false;
            if (!canTargetSelf && p.id === player.id) return false;
            return true;
          })
          .map(p => ({ id: p.id, name: p.name, isSelf: p.id === player.id }));
        sock.emit('your-night-turn', { role: current.role, targets, timeLeft: room.nightPhaseSeconds });
      }
    }

    room.nightTimer = setTimeout(() => {
      if (current.role === 'MAFIA_GROUP') {
        room.nightActions.mafiaKill = resolveMafiaVotes(room.nightActions.mafiaVotes);
      }
      const alreadyActed =
        (current.role === 'POLICE' && room.nightActions.policeInvestigate) ||
        (current.role === 'JOKER' && room.nightActions.jokerAction?.action === 'investigate');

      if (alreadyActed) {
        io.to(room.code).emit('night-turn-done', { role: current.role });
      } else {
        io.to(room.code).emit('night-turn-skipped', { role: current.role });
      }
      startNightTurn(room);
    }, (room.nightPhaseSeconds + 1) * 1000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Day Phase
// ─────────────────────────────────────────────────────────────────────────────

function startDayPhase(room) {
  room.phase = 'day-discuss';
  room.votes = {};

  const discussMs = room.discussionMinutes * 60 * 1000;

  io.to(room.code).emit('day-phase-start', {
    players: room.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name })),
    discussionSeconds: room.discussionMinutes * 60,
  });

  room.dayTimer = setTimeout(() => startVoting(room), discussMs);
}

function startVoting(room) {
  room.phase = 'voting';
  room.votes = {};

  io.to(room.code).emit('voting-start', {
    players: room.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name })),
    timeLeft: room.voteSeconds,
  });

  room.votingTimer = setTimeout(() => resolveVotes(room), (room.voteSeconds + 1) * 1000);
}

function resolveVotes(room) {
  clearTimeout(room.votingTimer);

  const tally = {};
  for (const [, votedFor] of Object.entries(room.votes)) {
    tally[votedFor] = (tally[votedFor] || 0) + 1;
  }

  let maxVotes = 0;
  let topCandidates = [];

  for (const [targetId, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count;
      topCandidates = [targetId];
    } else if (count === maxVotes) {
      topCandidates.push(targetId);
    }
  }

  let eliminatedPlayer = null;

  // When more than 2 players alive: need at least 2 votes to eliminate
  const aliveCount = room.players.filter(p => p.alive).length;
  const minVotesRequired = aliveCount > 2 ? 2 : 1;

  if (topCandidates.length === 1 && maxVotes >= minVotesRequired) {
    const target = room.players.find(p => p.id === topCandidates[0]);
    if (target) {
      // Jester check
      if (target.role === 'JESTER') {
        io.to(room.code).emit('vote-resolved', {
          eliminated: target.name,
          tie: false,
          votes: tally,
          jesterWin: true,
        });
        return endGame(room, { winner: 'Jester', reason: `${target.name} was the Jester and was voted out!` });
      }
      target.alive = false;
      eliminatedPlayer = target.name;

      // Remove from mafia chat
      if (ROLES[target.role].group === 'mafia') {
        io.sockets.sockets.get(target.id)?.leave(`mafia-${room.code}`);
      }
    }
  }

  io.to(room.code).emit('vote-resolved', {
    eliminated: eliminatedPlayer,
    tie: topCandidates.length !== 1,
    votes: tally,
    jesterWin: false,
  });

  const winResult = checkWinCondition(room);
  if (winResult) {
    return endGame(room, winResult);
  }

  // Start next night
  setTimeout(() => startNightPhase(room), 4000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Night Phase Start
// ─────────────────────────────────────────────────────────────────────────────

function startNightPhase(room) {
  room.phase = 'night';
  room.nightActed = new Set();
  room.nightActions = {
    mafiaKill: null,
    mafiaVotes: {},
    doctorSave: null,
    policeInvestigate: null,
    jokerAction: null,
    vigilanteKill: null,
  };
  room.ghostGuesses = {}; // Reset ghost predictions each night

  io.to(room.code).emit('night-phase-start', { round: room.round });

  // Passive ghost guess for eliminated non-night-ability players (Civilian, Jester, etc.)
  const ghostAlive = room.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name }));
  for (const dead of room.players.filter(p => !p.alive && !NIGHT_ACTORS.has(p.role))) {
    const sock = io.sockets.sockets.get(dead.id);
    if (sock) sock.emit('ghost-passive-turn', { alivePlayers: ghostAlive });
  }

  setTimeout(() => startNightTurn(room), 2000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Game End
// ─────────────────────────────────────────────────────────────────────────────

function endGame(room, result) {
  room.phase = 'ended';
  clearTimeout(room.nightTimer);
  clearTimeout(room.dayTimer);
  clearTimeout(room.votingTimer);

  const roleReveal = room.players.map(p => ({
    name: p.name,
    role: ROLES[p.role].name,
    group: ROLES[p.role].group,
    alive: p.alive,
  }));

  io.to(room.code).emit('game-over', {
    winner: result.winner,
    reason: result.reason,
    roleReveal,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO Events
// ─────────────────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Game ──────────────────────────────────────────────────────────
  socket.on('create-game', ({ playerName }) => {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    const player = {
      id: socket.id,
      name: playerName.trim(),
      role: null,
      alive: true,
      killFlagged: false,
      isHost: true,
    };

    rooms[code] = {
      code,
      phase: 'lobby',
      players: [player],
      discussionMinutes: 3,
      nightPhaseSeconds: 30,
      voteSeconds: 30,
      round: 1,
      nightActed: new Set(),
      nightActions: {},
      ghostGuesses: {},
      votes: {},
      nightTimer: null,
      dayTimer: null,
      votingTimer: null,
    };

    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName.trim();

    socket.emit('game-created', { code, playerName: player.name });
    io.to(code).emit('lobby-update', {
      players: rooms[code].players.map(p => ({ name: p.name, isHost: p.isHost })),
      hostName: player.name,
    });

    console.log(`[ROOM] Created room ${code} by ${playerName}`);
  });

  // ── Join Game ────────────────────────────────────────────────────────────
  socket.on('join-game', ({ playerName, roomCode }) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) return socket.emit('error', { message: 'Room not found. Check the code and try again.' });
    if (room.phase !== 'lobby') return socket.emit('error', { message: 'Game has already started.' });
    if (room.players.length >= 10) return socket.emit('error', { message: 'Room is full (max 10 players).' });
    if (room.players.find(p => p.name.toLowerCase() === playerName.trim().toLowerCase())) {
      return socket.emit('error', { message: 'Name already taken. Choose another name.' });
    }

    const player = {
      id: socket.id,
      name: playerName.trim(),
      role: null,
      alive: true,
      killFlagged: false,
      isHost: false,
    };

    room.players.push(player);
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName.trim();

    socket.emit('game-joined', { code, playerName: player.name });
    io.to(code).emit('lobby-update', {
      players: room.players.map(p => ({ name: p.name, isHost: p.isHost })),
      hostName: room.players.find(p => p.isHost)?.name,
    });

    console.log(`[ROOM] ${playerName} joined room ${code}`);
  });

  // ── Set Discussion Timer ──────────────────────────────────────────────────
  socket.on('set-timer', ({ minutes }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    room.discussionMinutes = Math.min(5, Math.max(1, parseInt(minutes)));
    socket.emit('timer-updated', { minutes: room.discussionMinutes });
  });

  socket.on('set-night-timer', ({ seconds }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    room.nightPhaseSeconds = Math.min(120, Math.max(10, Math.round(parseInt(seconds) / 10) * 10));
    socket.emit('night-timer-updated', { seconds: room.nightPhaseSeconds });
  });

  socket.on('set-vote-timer', ({ seconds }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    room.voteSeconds = Math.min(60, Math.max(10, Math.round(parseInt(seconds) / 10) * 10));
    socket.emit('vote-timer-updated', { seconds: room.voteSeconds });
  });

  // ── Start Game ────────────────────────────────────────────────────────────
  socket.on('start-game', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const host = room.players.find(p => p.id === socket.id);
    if (!host?.isHost) return socket.emit('error', { message: 'Only the host can start the game.' });
    if (room.players.length < 6) return socket.emit('error', { message: 'Need at least 6 players to start.' });

    const roleList = assignRoles(room.players.length);
    room.players.forEach((p, i) => { p.role = roleList[i]; });

    // Send each player their role privately
    for (const player of room.players) {
      const sock = io.sockets.sockets.get(player.id);
      if (sock) {
        const roleInfo = ROLES[player.role];

        // Join mafia room
        if (roleInfo.group === 'mafia') {
          sock.join(`mafia-${room.code}`);
        }

        sock.emit('role-assigned', {
          role: roleInfo.name,
          roleKey: player.role,
          group: roleInfo.group,
          description: getRoleDescription(player.role),
        });
      }
    }

    // Tell all who are mafia (for mafia members only via separate channel)
    const mafiaNames = room.players
      .filter(p => ROLES[p.role].group === 'mafia')
      .map(p => p.name);

    io.to(`mafia-${room.code}`).emit('mafia-reveal', { mafiaNames });

    io.to(room.code).emit('game-started', {
      playerCount: room.players.length,
      players: room.players.map(p => ({ id: p.id, name: p.name })),
    });

    room.round = 1;
    room.playersReady = new Set();
    // Night phase starts only after every player clicks "Enter the Game"
  });

  // ── Role Ready (gate before night phase) ───────────────────────────────────
  socket.on('role-ready', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'lobby') return;

    room.playersReady.add(socket.id);

    const totalPlayers = room.players.length;
    const readyPlayers = room.players.filter(p => room.playersReady.has(p.id)).map(p => p.name);
    const waitingPlayers = room.players.filter(p => !room.playersReady.has(p.id)).map(p => p.name);

    // Broadcast progress to everyone
    io.to(room.code).emit('role-ready-update', {
      readyPlayers,
      waitingPlayers,
      totalReady: readyPlayers.length,
      total: totalPlayers,
    });

    // All players ready → start night phase
    if (readyPlayers.length === totalPlayers) {
      startNightPhase(room);
    }
  });

  // ── Night Actions ─────────────────────────────────────────────────────────

  // Mafia vote (collective)
  socket.on('mafia-vote', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || ROLES[voter.role].group !== 'mafia' || !voter.alive) return;

    room.nightActions.mafiaVotes[socket.id] = targetId;

    // Tally votes — need a clear majority; tie or zero votes = no kill
    room.nightActions.mafiaKill = resolveMafiaVotes(room.nightActions.mafiaVotes);

    const mafiaAlive = room.players.filter(p => p.alive && ROLES[p.role].group === 'mafia');
    const allVoted = mafiaAlive.every(p => room.nightActions.mafiaVotes[p.id]);

    // Broadcast vote status to mafia chat
    io.to(`mafia-${room.code}`).emit('mafia-vote-update', {
      votes: room.nightActions.mafiaVotes,
      currentTarget: room.nightActions.mafiaKill,
      allVoted,
    });

    if (allVoted) {
      // All mafia have voted — finalise and advance immediately
      clearTimeout(room.nightTimer);
      io.to(room.code).emit('night-turn-done', { role: 'MAFIA_GROUP' });
      setTimeout(() => startNightTurn(room), 1500);
    }
  });

  // Doctor save
  socket.on('doctor-action', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const doctor = room.players.find(p => p.id === socket.id && p.role === 'DOCTOR' && p.alive);
    if (!doctor) return;

    room.nightActions.doctorSave = targetId;
    clearTimeout(room.nightTimer);
    io.to(room.code).emit('night-turn-done', { role: 'DOCTOR' });
    setTimeout(() => startNightTurn(room), 1500);
  });

  // Police investigate
  socket.on('police-action', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const police = room.players.find(p => p.id === socket.id && p.role === 'POLICE' && p.alive);
    if (!police) return;
    if (room.nightActions.policeInvestigate) return; // already investigated this night

    const target = room.players.find(p => p.id === targetId);
    if (!target) return;

    // Traitor appears as Civilian
    let revealedGroup = ROLES[target.role].group;
    if (target.role === 'TRAITOR') revealedGroup = 'civilian';
    const revealedRole = target.role === 'TRAITOR' ? 'Civilian' : ROLES[target.role].name;

    // Send result privately — timer keeps running; client shows result inline
    socket.emit('investigation-result', {
      targetName: target.name,
      group: revealedGroup,
      role: revealedRole,
    });

    room.nightActions.policeInvestigate = targetId;
    // Do NOT advance the turn — let the 31s timer fire naturally
  });

  // Joker action
  socket.on('joker-action', ({ action, targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const joker = room.players.find(p => p.id === socket.id && p.role === 'JOKER' && p.alive);
    if (!joker) return;
    if (room.nightActions.jokerAction) return; // already acted this night

    if (action === 'investigate') {
      const target = room.players.find(p => p.id === targetId);
      if (target) {
        let revealedGroup = ROLES[target.role].group;
        if (target.role === 'TRAITOR') revealedGroup = 'civilian';
        socket.emit('investigation-result', {
          targetName: target.name,
          group: revealedGroup,
          role: target.role === 'TRAITOR' ? 'Civilian' : ROLES[target.role].name,
        });
      }
      // Record action but keep timer running — client shows result inline
      room.nightActions.jokerAction = { action, targetId };
      return;
    }

    // Kill or protect: advance the turn immediately as before
    room.nightActions.jokerAction = { action, targetId };
    clearTimeout(room.nightTimer);
    io.to(room.code).emit('night-turn-done', { role: 'JOKER' });
    setTimeout(() => startNightTurn(room), 1500);
  });

  // Player clicked Done on investigation result — advance turn early
  socket.on('investigation-done', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const player = room.players.find(p => p.id === socket.id && p.alive);
    if (!player) return;

    // Only valid for Police who investigated, or Joker who used investigate
    const isPolice = player.role === 'POLICE' && room.nightActions.policeInvestigate;
    const isJokerInvestigate = player.role === 'JOKER' && room.nightActions.jokerAction?.action === 'investigate';
    if (!isPolice && !isJokerInvestigate) return;

    clearTimeout(room.nightTimer);
    io.to(room.code).emit('night-turn-done', { role: player.role === 'POLICE' ? 'POLICE' : 'JOKER' });
    setTimeout(() => startNightTurn(room), 1500);
  });

  // Vigilante action
  socket.on('vigilante-action', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const vig = room.players.find(p => p.id === socket.id && p.role === 'VIGILANTE' && p.alive);
    if (!vig) return;

    room.nightActions.vigilanteKill = targetId;
    clearTimeout(room.nightTimer);
    io.to(room.code).emit('night-turn-done', { role: 'VIGILANTE' });
    setTimeout(() => startNightTurn(room), 1500);
  });

  socket.on('skip-vigilante-action', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const vig = room.players.find(p => p.id === socket.id && p.role === 'VIGILANTE' && p.alive);
    if (!vig) return;
    clearTimeout(room.nightTimer);
    io.to(room.code).emit('night-turn-skipped', { role: 'VIGILANTE' });
    setTimeout(() => startNightTurn(room), 1500);
  });

  socket.on('ghost-guess', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const player = room.players.find(p => p.id === socket.id && !p.alive);
    if (!player) return;
    room.ghostGuesses[socket.id] = targetId;
    socket.emit('ghost-guess-ack');
    // Only timed ghost turns (night-ability roles) advance the turn on guess
    // Passive ghosts (Civilian, Jester) just record and stay on the wait panel
    if (NIGHT_ACTORS.has(player.role)) {
      clearTimeout(room.nightTimer);
      setTimeout(() => {
        io.to(room.code).emit('night-turn-done', { role: player.role });
        setTimeout(() => startNightTurn(room), 1000);
      }, 600);
    }
  });

  // ── Day Phase ─────────────────────────────────────────────────────────────

  // Chat message (mafia-only)
  socket.on('mafia-chat', ({ message }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || ROLES[player.role].group !== 'mafia' || !player.alive) return;

    io.to(`mafia-${room.code}`).emit('mafia-chat-message', {
      sender: player.name,
      message: message.trim().substring(0, 300),
      timestamp: new Date().toLocaleTimeString(),
    });
  });

  // Vote
  socket.on('cast-vote', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'voting') return;
    const voter = room.players.find(p => p.id === socket.id && p.alive);
    if (!voter) return;

    room.votes[socket.id] = targetId;

    const totalAlive = room.players.filter(p => p.alive).length;
    const totalVoted = Object.keys(room.votes).length;

    io.to(room.code).emit('vote-update', {
      votedCount: totalVoted,
      totalCount: totalAlive,
    });

    // If everyone voted, resolve early
    if (totalVoted >= totalAlive) {
      clearTimeout(room.votingTimer);
      resolveVotes(room);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    console.log(`[-] Disconnected: ${player.name} from room ${code}`);

    if (room.phase === 'lobby') {
      // Remove from lobby
      room.players = room.players.filter(p => p.id !== socket.id);

      // If host left, assign new host
      if (player.isHost && room.players.length > 0) {
        room.players[0].isHost = true;
        io.to(code).emit('host-changed', { newHost: room.players[0].name });
      }

      if (room.players.length === 0) {
        delete rooms[code];
        return;
      }

      io.to(code).emit('lobby-update', {
        players: room.players.map(p => ({ name: p.name, isHost: p.isHost })),
        hostName: room.players.find(p => p.isHost)?.name,
      });
    } else {
      // Mid-game disconnect: mark as dead
      player.alive = false;
      io.to(code).emit('player-disconnected', { name: player.name });

      const winResult = checkWinCondition(room);
      if (winResult) endGame(room, winResult);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Role Descriptions
// ─────────────────────────────────────────────────────────────────────────────

function getRoleDescription(roleKey) {
  const descriptions = {
    MAFIA: 'You are Mafia. Each night, vote with your team to eliminate a civilian.',
    TRAITOR: 'You are a Traitor. You work with the Mafia but appear as Civilian to investigators.',
    DOCTOR: 'You are the Doctor. Each night, choose one player to protect from elimination.',
    POLICE: 'You are the Police. Each night, investigate one player to learn their identity.',
    VIGILANTE: 'You are the Vigilante. Each night, you may kill one player. If your target is Civilian, you die instead.',
    JESTER: 'You are the Jester. Get voted out during the day to win! (You have no night ability)',
    JOKER: 'You are the Joker. Each night you may kill, protect, or investigate one player.',
    CIVILIAN: 'You are a Civilian. Survive the night and help identify the Mafia during the day.',
  };
  return descriptions[roleKey] || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🎭 Mafia Game Server running at http://localhost:${PORT}`);
  console.log(`   Share your local IP with teammates on the same network`);
  console.log(`   For VPN users: run 'npx ngrok http ${PORT}' for a public URL\n`);
});
