const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const {
  ROLES, ROLE_CATALOGUE, NIGHT_ORDER, NIGHT_ACTORS,
  assignRoles, checkWinCondition, getNextNightActor,
  resolveMafiaVotes, resolveNightActions, resolveVotesPure,
  validateCustomRoles, getRoleDescription,
} = require('./gameLogic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Game State Storage
// ─────────────────────────────────────────────────────────────────────────────

const rooms = {}; // roomCode → gameState

// ─────────────────────────────────────────────────────────────────────────────
// Night Turn Timer
// ─────────────────────────────────────────────────────────────────────────────

function startNightTurn(room) {
  clearTimeout(room.nightTimer);

  const current = getNextNightActor(room);

  if (!current) {
    // All night actors done → resolve and start day
    const { eliminated, events, correctGuessers } = resolveNightActions(room, io);
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
        const anyVoted = Object.keys(room.nightActions.mafiaVotes).length > 0;
        io.to(room.code).emit(anyVoted ? 'night-turn-done' : 'night-turn-skipped', { role: current.role });
        startNightTurn(room);
        return;
      }

      // For roles with multiple players: determine if ANY of them acted
      const roleActingPlayers = current.players.map(p => p.id);
      let anyActed = false;
      if (current.role === 'DOCTOR') {
        anyActed = room.nightActions.doctorSaves.length > 0;
      } else if (current.role === 'POLICE') {
        anyActed = room.nightActions.policeInvestigations.length > 0;
      } else if (current.role === 'JOKER') {
        anyActed = room.nightActions.jokerActions.length > 0;
      } else if (current.role === 'VIGILANTE') {
        anyActed = room.nightActions.vigilanteKills.length > 0;
      }

      io.to(room.code).emit(anyActed ? 'night-turn-done' : 'night-turn-skipped', { role: current.role });
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
  room.voteLog = []; // ordered list of { voterName, targetName|null }

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

  // Separate player votes from explicit skips
  const skipCountFromVotes = tally['null'] || 0;
  delete tally['null']; // Remove 'null' from candidates

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

  const alivePlayersList = room.players.filter(p => p.alive);
  const aliveCount = alivePlayersList.length;

  // Voters who cast a vote
  const voteDetails = room.voteLog.map(entry => ({
    voterName: entry.voterName,
    targetName: entry.targetName, // null = explicit skip
  }));

  // Alive players who never voted at all
  const votedIds = new Set(Object.keys(room.votes));
  const noVoteNames = alivePlayersList
    .filter(p => !votedIds.has(p.id))
    .map(p => p.name);

  // Total skips = explicit skips + no votes (failure to act)
  const totalSkipCount = skipCountFromVotes + noVoteNames.length;

  let eliminatedPlayer = null;
  let tie = topCandidates.length !== 1;
  let skippedOverride = false;

  // New Rule: Elimination only happens if maxVotes > totalSkipCount
  if (!tie && maxVotes > 0) {
    if (maxVotes <= totalSkipCount) {
      skippedOverride = true;
    } else {
      const target = room.players.find(p => p.id === topCandidates[0]);
      if (target) {
        // Jester check
        if (target.role === 'JESTER') {
          io.to(room.code).emit('vote-resolved', {
            eliminated: target.name, tie: false, skippedOverride: false,
            votes: tally, voteDetails, noVoteNames, jesterWin: true,
          });
          return endGame(room, { winner: 'Jester', reason: `${target.name} was the Jester and was voted out!` });
        }
        target.alive = false;
        eliminatedPlayer = target.name;
        if (ROLES[target.role].group === 'mafia') {
          io.sockets.sockets.get(target.id)?.leave(`mafia-${room.code}`);
        }
      }
    }
  }

  io.to(room.code).emit('vote-resolved', {
    eliminated: eliminatedPlayer,
    tie: tie,
    skippedOverride: skippedOverride,
    votes: tally,
    voteDetails,
    noVoteNames,
    jesterWin: false,
  });

  const winResult = checkWinCondition(room);
  if (winResult) return endGame(room, winResult);

  // 7s delay — leaves 5s for the day outcome splash before night starts
  setTimeout(() => startNightPhase(room), 7000);
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
    doctorSaves: [],         // [{ playerId, targetId }]
    policeInvestigations: [],// [{ playerId, targetId }] — for tracking; result sent privately
    jokerActions: [],        // [{ playerId, action, targetId }]
    vigilanteKills: [],      // [{ playerId, targetId }]
  };
  // Per-player acted tracking (for early-advance logic)
  room.nightActedPlayers = new Set();
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
      mode: 'auto',
      locked: false,
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
    if (room.locked) return socket.emit('error', { message: 'The host has locked the room to pick roles. No new players can join.' });
    const maxPlayers = room.mode === 'custom' ? 20 : 10;
    if (room.players.length >= maxPlayers) return socket.emit('error', { message: `Room is full (max ${maxPlayers} players).` });
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

  // ── Set Mode ─────────────────────────────────────────────────────────────
  socket.on('set-mode', ({ mode }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (!['auto', 'custom'].includes(mode)) return;
    room.mode = mode;
    io.to(room.code).emit('mode-updated', { mode });
  });

  // ── Lock Room (host clicked Pick Roles) ──────────────────────────────────
  socket.on('lock-room', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    room.locked = true;
    io.to(room.code).emit('room-locked', {
      roleCatalogue: ROLE_CATALOGUE,
      playerCount: room.players.length,
    });
  });

  // ── Start Game ────────────────────────────────────────────────────────────
  socket.on('start-game', ({ customRoles } = {}) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const host = room.players.find(p => p.id === socket.id);
    if (!host?.isHost) return socket.emit('error', { message: 'Only the host can start the game.' });
    if (room.players.length < 6) return socket.emit('error', { message: 'Need at least 6 players to start.' });

    let roleList;
    if (room.mode === 'custom' && customRoles) {
      // Server-side validation of custom role list
      if (customRoles.length !== room.players.length) {
        return socket.emit('error', { message: 'Role count does not match player count.' });
      }
      const mafiaCount    = customRoles.filter(r => ROLES[r] && ROLES[r].group === 'mafia').length;
      const civilianCount = customRoles.filter(r => ROLES[r] && ROLES[r].group === 'civilian').length;
      if (mafiaCount < 2) return socket.emit('error', { message: 'Need at least 2 Mafia House players.' });
      if (civilianCount < 2) return socket.emit('error', { message: 'Need at least 2 Civilian Town players.' });
      // Shuffle the valid custom role list
      roleList = [...customRoles];
      for (let i = roleList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
      }
    } else {
      roleList = assignRoles(room.players.length);
    }
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
    if (room.nightActedPlayers.has(socket.id)) return; // this doctor already acted

    room.nightActions.doctorSaves.push({ playerId: socket.id, targetId });
    room.nightActedPlayers.add(socket.id);

    // Advance early only if ALL doctors have acted
    const doctorPlayers = room.players.filter(p => p.role === 'DOCTOR' && p.alive);
    const allActed = doctorPlayers.every(p => room.nightActedPlayers.has(p.id));
    if (allActed) {
      clearTimeout(room.nightTimer);
      io.to(room.code).emit('night-turn-done', { role: 'DOCTOR' });
      setTimeout(() => startNightTurn(room), 1500);
    }
  });

  // Police investigate
  socket.on('police-action', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const police = room.players.find(p => p.id === socket.id && p.role === 'POLICE' && p.alive);
    if (!police) return;
    if (room.nightActedPlayers.has(socket.id)) return; // this officer already investigated

    const target = room.players.find(p => p.id === targetId);
    if (!target) return;

    // Traitor appears as Civilian
    let revealedGroup = ROLES[target.role].group;
    if (target.role === 'TRAITOR') revealedGroup = 'civilian';

    // Send result privately
    socket.emit('investigation-result', { targetName: target.name, group: revealedGroup });

    room.nightActions.policeInvestigations.push({ playerId: socket.id, targetId });
    room.nightActedPlayers.add(socket.id);
    // Timer keeps running; client shows result inline and can click Done
  });

  // Joker action
  socket.on('joker-action', ({ action, targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const joker = room.players.find(p => p.id === socket.id && p.role === 'JOKER' && p.alive);
    if (!joker) return;
    if (room.nightActedPlayers.has(socket.id)) return; // this joker already acted

    if (action === 'investigate') {
      const target = room.players.find(p => p.id === targetId);
      if (target) {
        let revealedGroup = ROLES[target.role].group;
        if (target.role === 'TRAITOR') revealedGroup = 'civilian';
        socket.emit('investigation-result', { targetName: target.name, group: revealedGroup });
      }
      room.nightActions.jokerActions.push({ playerId: socket.id, action, targetId });
      room.nightActedPlayers.add(socket.id);
      // Timer keeps running; don't advance yet so player can click Done
      return;
    }

    // Kill or protect
    room.nightActions.jokerActions.push({ playerId: socket.id, action, targetId });
    room.nightActedPlayers.add(socket.id);

    // Advance early if ALL jokers have acted
    const jokerPlayers = room.players.filter(p => p.role === 'JOKER' && p.alive);
    const allActed = jokerPlayers.every(p => room.nightActedPlayers.has(p.id));
    if (allActed) {
      clearTimeout(room.nightTimer);
      io.to(room.code).emit('night-turn-done', { role: 'JOKER' });
      setTimeout(() => startNightTurn(room), 1500);
    }
  });

  // Player clicked Done on investigation result — advance turn early if all police/jokers done
  socket.on('investigation-done', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const player = room.players.find(p => p.id === socket.id && p.alive);
    if (!player) return;

    const isPolice = player.role === 'POLICE' && room.nightActedPlayers.has(socket.id);
    const isJokerInv = player.role === 'JOKER'
      && room.nightActions.jokerActions.some(a => a.playerId === socket.id && a.action === 'investigate');
    if (!isPolice && !isJokerInv) return;

    // Mark this player as fully done
    room.nightActedPlayers.add(socket.id + '_done');

    // Advance only if ALL players of this role have signalled done
    const rolePlayers = room.players.filter(p => p.role === player.role && p.alive);
    const allDone = rolePlayers.every(p => room.nightActedPlayers.has(p.id + '_done'));
    if (allDone) {
      clearTimeout(room.nightTimer);
      io.to(room.code).emit('night-turn-done', { role: player.role });
      setTimeout(() => startNightTurn(room), 1500);
    }
  });

  // Vigilante action
  socket.on('vigilante-action', ({ targetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const vig = room.players.find(p => p.id === socket.id && p.role === 'VIGILANTE' && p.alive);
    if (!vig) return;
    if (room.nightActedPlayers.has(socket.id)) return; // this vigilante already acted

    room.nightActions.vigilanteKills.push({ playerId: socket.id, targetId });
    room.nightActedPlayers.add(socket.id);

    // Advance early if ALL vigilantes have acted
    const vigPlayers = room.players.filter(p => p.role === 'VIGILANTE' && p.alive);
    const allActed = vigPlayers.every(p => room.nightActedPlayers.has(p.id));
    if (allActed) {
      clearTimeout(room.nightTimer);
      io.to(room.code).emit('night-turn-done', { role: 'VIGILANTE' });
      setTimeout(() => startNightTurn(room), 1500);
    }
  });

  socket.on('skip-vigilante-action', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'night') return;
    const vig = room.players.find(p => p.id === socket.id && p.role === 'VIGILANTE' && p.alive);
    if (!vig) return;
    if (room.nightActedPlayers.has(socket.id)) return;

    room.nightActedPlayers.add(socket.id);

    // Advance early if ALL vigilantes have now skipped or acted
    const vigPlayers = room.players.filter(p => p.role === 'VIGILANTE' && p.alive);
    const allDone = vigPlayers.every(p => room.nightActedPlayers.has(p.id));
    if (allDone) {
      clearTimeout(room.nightTimer);
      const anyKilled = room.nightActions.vigilanteKills.length > 0;
      io.to(room.code).emit(anyKilled ? 'night-turn-done' : 'night-turn-skipped', { role: 'VIGILANTE' });
      setTimeout(() => startNightTurn(room), 1500);
    }
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

    // Record for ordered vote log
    const targetPlayer = targetId ? room.players.find(p => p.id === targetId) : null;
    const entry = { voterName: voter.name, targetName: targetPlayer?.name || null };
    room.voteLog.push(entry);

    const totalAlive = room.players.filter(p => p.alive).length;
    const totalVoted = Object.keys(room.votes).length;

    // Live vote feed update
    io.to(room.code).emit('vote-cast', {
      voterName: voter.name,
      targetName: entry.targetName, // null = abstained
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
// Start Server
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🎭 Mafia Game Server running at http://localhost:${PORT}`);
  console.log(`   Share your local IP with teammates on the same network`);
  console.log(`   For VPN users: run 'npx ngrok http ${PORT}' for a public URL\n`);
});
