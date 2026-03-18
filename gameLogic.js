'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// gameLogic.js — Pure game logic, zero networking dependencies.
// server.js requires this module so all business rules can be unit-tested
// without spinning up Express / Socket.IO.
// ─────────────────────────────────────────────────────────────────────────────

// ── Role & Group Definitions ─────────────────────────────────────────────────
const ROLES = {
  MAFIA:     { name: 'Mafia',      group: 'mafia',    special: false },
  TRAITOR:   { name: 'Traitor',    group: 'mafia',    special: true  },
  DOCTOR:    { name: 'Doctor',     group: 'civilian', special: false },
  POLICE:    { name: 'Police',     group: 'civilian', special: false },
  VIGILANTE: { name: 'Vigilante',  group: 'civilian', special: true  },
  JESTER:    { name: 'Jester',     group: 'neutral',  special: true  },
  JOKER:     { name: 'Joker',      group: 'neutral',  special: false },
  CIVILIAN:  { name: 'Civilian',   group: 'civilian', special: false },
};

// Night phase action order — Mafia Group first, then Civilian, then Neutral.
// CIVILIAN and JESTER are excluded — they have no night action.
const NIGHT_ORDER = ['MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JOKER'];

// Set of roles that actually DO something at night
const NIGHT_ACTORS = new Set(['MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JOKER']);

// Role catalogue — single source of truth for the Custom role picker UI
const ROLE_CATALOGUE = {
  mafia:    ['MAFIA', 'TRAITOR'],
  civilian: ['CIVILIAN', 'DOCTOR', 'POLICE', 'VIGILANTE'],
  neutral:  ['JOKER', 'JESTER'],
};

// ── Role Assignment ──────────────────────────────────────────────────────────
/**
 * Returns a shuffled role array for Auto mode.
 * Valid playerCounts: 6-10.
 * Returns empty array for unsupported counts.
 */
function assignRoles(playerCount) {
  let roles = [];
  if (playerCount === 6) {
    roles = ['MAFIA', 'MAFIA', 'DOCTOR', 'POLICE', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 7) {
    roles = ['MAFIA', 'MAFIA', 'DOCTOR', 'POLICE', 'CIVILIAN', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 8) {
    roles = ['MAFIA', 'MAFIA', 'MAFIA', 'DOCTOR', 'POLICE', 'CIVILIAN', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 9) {
    roles = ['MAFIA', 'MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'CIVILIAN', 'CIVILIAN', 'CIVILIAN', 'JOKER'];
  } else if (playerCount === 10) {
    roles = ['MAFIA', 'MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'CIVILIAN', 'CIVILIAN', 'JOKER', 'JESTER'];
  }
  // Shuffle (Fisher-Yates)
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

// ── Win Condition ────────────────────────────────────────────────────────────
/**
 * Returns { winner, reason } if game over, or null to continue.
 */
function checkWinCondition(room) {
  const alive = room.players.filter(p => p.alive);
  const mafiaCount    = alive.filter(p => ROLES[p.role].group === 'mafia').length;
  const civilianCount = alive.filter(p => ROLES[p.role].group === 'civilian').length;
  const neutralCount  = alive.filter(p => ROLES[p.role].group === 'neutral').length;

  // Both Mafia and Civilian gone — Neutrals win (if any remain)
  if (mafiaCount === 0 && civilianCount === 0 && neutralCount >= 1) {
    return { winner: 'Neutrals', reason: 'Only Neutrals remain' };
  }
  // No Civilians — Mafia wins
  if (civilianCount === 0) {
    return { winner: 'Mafia', reason: 'All Civilians have been eliminated' };
  }
  // No Mafia — Civilians win
  if (mafiaCount === 0) {
    return { winner: 'Civilians', reason: 'All Mafia have been eliminated' };
  }
  // Exactly 1 Civilian and no Neutrals — Mafia outnumber
  if (civilianCount === 1 && neutralCount === 0) {
    return { winner: 'Mafia', reason: 'Mafia outnumbers the last Civilian' };
  }
  return null;
}

// ── Night Phase Helpers ──────────────────────────────────────────────────────
/**
 * Returns the next { role, players, isGhost } actor group, or null when done.
 * Mutates room.nightActed (Set) to track which roles have gone.
 */
function getNextNightActor(room) {
  for (const roleKey of NIGHT_ORDER) {
    if (!NIGHT_ACTORS.has(roleKey)) continue;

    if (roleKey === 'MAFIA' || roleKey === 'TRAITOR') {
      if (room.nightActed.has('MAFIA_GROUP')) continue;
      const mafiaAlive = room.players.filter(p => ROLES[p.role].group === 'mafia' && p.alive);
      const mafiaDead  = room.players.filter(p => ROLES[p.role].group === 'mafia' && !p.alive);
      if (!room.nightActed.has('MAFIA_GROUP')) {
        room.nightActed.add('MAFIA_GROUP');
        if (mafiaAlive.length > 0) return { role: 'MAFIA_GROUP', players: mafiaAlive, isGhost: false };
        if (mafiaDead.length  > 0) return { role: 'MAFIA_GROUP', players: mafiaDead,  isGhost: true  };
      }
    } else {
      if (room.nightActed.has(roleKey)) continue;
      const alivePlayers = room.players.filter(p => p.role === roleKey && p.alive);
      if (alivePlayers.length > 0) {
        room.nightActed.add(roleKey);
        return { role: roleKey, players: alivePlayers, isGhost: false };
      }
      const deadPlayers = room.players.filter(p => p.role === roleKey && !p.alive);
      if (deadPlayers.length > 0) {
        room.nightActed.add(roleKey);
        return { role: roleKey, players: deadPlayers, isGhost: true };
      }
    }
  }
  return null;
}

/**
 * Resolves mafia votes to a single target id (strict majority), or null on tie/no votes.
 */
function resolveMafiaVotes(mafiaVotes) {
  const votes = Object.values(mafiaVotes);
  if (votes.length === 0) return null;

  const tally = {};
  for (const v of votes) tally[v] = (tally[v] || 0) + 1;

  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 1 || sorted[0][1] > sorted[1][1]) return sorted[0][0];
  return null;
}

/**
 * Applies all queued night actions to room.players, returning { eliminated, events, correctGuessers }.
 * @param {object} room
 * @param {object} [ioStub] - Optional Socket.IO instance; used only to call leave() on mafia members
 *                            that die. Defaults to a no-op so tests don't need a real io.
 */
function resolveNightActions(room, ioStub = null) {
  const events = [];
  const _io = ioStub || { sockets: { sockets: { get: () => null } } };

  // Mafia kill
  if (room.nightActions.mafiaKill) {
    const target = room.players.find(p => p.id === room.nightActions.mafiaKill);
    if (target) target.killFlagged = true;
  }

  // Doctor saves
  for (const { targetId } of room.nightActions.doctorSaves) {
    const target = room.players.find(p => p.id === targetId);
    if (target && target.killFlagged) target.killFlagged = false;
  }

  // Joker actions (protect beats kill on same target)
  const jokerKills    = room.nightActions.jokerActions.filter(a => a.action === 'kill');
  const jokerProtects = room.nightActions.jokerActions.filter(a => a.action === 'protect');
  for (const { targetId } of jokerKills) {
    const target = room.players.find(p => p.id === targetId);
    if (target) target.killFlagged = true;
  }
  for (const { targetId } of jokerProtects) {
    const target = room.players.find(p => p.id === targetId);
    if (target && target.killFlagged) {
      target.killFlagged = false;
      events.push({ type: 'save', message: 'A Joker protected someone tonight!' });
    }
  }

  // Vigilante kills (backfire on civilian targets)
  for (const { playerId, targetId } of room.nightActions.vigilanteKills) {
    const target    = room.players.find(p => p.id === targetId);
    const vigilante = room.players.find(p => p.id === playerId);
    if (target && vigilante) {
      if (ROLES[target.role].group === 'civilian') {
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
      if (ROLES[player.role].group === 'mafia') {
        _io.sockets.sockets.get(player.id)?.leave(`mafia-${room.code}`);
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

// ── Day Vote Resolution ──────────────────────────────────────────────────────
/**
 * Pure vote resolution — processes room.votes / room.voteLog and returns a
 * result object without emitting any socket events.
 *
 * Returns:
 *   { eliminatedId, eliminatedName, eliminatedRole, tie, skippedOverride, jesterWin }
 */
function resolveVotesPure(room) {
  const tally = {};
  for (const [, votedFor] of Object.entries(room.votes)) {
    tally[votedFor] = (tally[votedFor] || 0) + 1;
  }

  const skipCountFromVotes = tally['null'] || 0;
  delete tally['null'];

  let maxVotes     = 0;
  let topCandidates = [];
  for (const [targetId, count] of Object.entries(tally)) {
    if (count > maxVotes)      { maxVotes = count; topCandidates = [targetId]; }
    else if (count === maxVotes) topCandidates.push(targetId);
  }

  const alivePlayersList = room.players.filter(p => p.alive);
  const votedIds    = new Set(Object.keys(room.votes));
  const noVoteNames = alivePlayersList.filter(p => !votedIds.has(p.id)).map(p => p.name);
  const totalSkipCount = skipCountFromVotes + noVoteNames.length;

  const tie            = topCandidates.length !== 1;
  let skippedOverride  = false;
  let eliminatedId     = null;
  let eliminatedName   = null;
  let eliminatedRole   = null;
  let jesterWin        = false;

  if (!tie && maxVotes > 0) {
    if (maxVotes <= totalSkipCount) {
      skippedOverride = true;
    } else {
      const target = room.players.find(p => p.id === topCandidates[0]);
      if (target) {
        eliminatedId   = target.id;
        eliminatedName = target.name;
        eliminatedRole = target.role;
        jesterWin      = target.role === 'JESTER';
        if (!jesterWin) target.alive = false;
      }
    }
  }

  return { eliminatedId, eliminatedName, eliminatedRole, tie, skippedOverride, jesterWin, noVoteNames };
}

// ── Custom Role Validation ───────────────────────────────────────────────────
/**
 * Validates a custom role assignment array before starting the game.
 * Returns { valid: true } or { valid: false, error: string }.
 *
 * Rules:
 *  - Every role key must exist in ROLES
 *  - Total count must equal playerCount
 *  - At least 2 Mafia-group roles
 *  - At least 2 Civilian-group roles
 */
function validateCustomRoles(roleList, playerCount) {
  if (!Array.isArray(roleList) || roleList.length !== playerCount) {
    return { valid: false, error: `Role count (${roleList?.length}) must equal player count (${playerCount}).` };
  }
  for (const r of roleList) {
    if (!ROLES[r]) return { valid: false, error: `Unknown role: ${r}` };
  }
  const mafiaCount    = roleList.filter(r => ROLES[r].group === 'mafia').length;
  const civilianCount = roleList.filter(r => ROLES[r].group === 'civilian').length;
  if (mafiaCount < 2)    return { valid: false, error: 'At least 2 Mafia-group roles required.' };
  if (civilianCount < 2) return { valid: false, error: 'At least 2 Civilian-group roles required.' };
  return { valid: true };
}

// ── Role Descriptions ────────────────────────────────────────────────────────
function getRoleDescription(roleKey) {
  const descriptions = {
    MAFIA:     'You are Mafia. Each night, vote with your team to eliminate a civilian.',
    TRAITOR:   'You are a Traitor. You work with the Mafia but appear as Civilian to investigators.',
    DOCTOR:    'You are the Doctor. Each night, choose one player to protect from elimination.',
    POLICE:    'You are the Police. Each night, investigate one player to learn their identity.',
    VIGILANTE: 'You are the Vigilante. Each night, you may kill one player. If your target is Civilian, you die instead.',
    JESTER:    'You are the Jester. Get voted out during the day to win! (You have no night ability)',
    JOKER:     'You are the Joker. Each night you may kill, protect, or investigate one player.',
    CIVILIAN:  'You are a Civilian. Survive the night and help identify the Mafia during the day.',
  };
  return descriptions[roleKey] || '';
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  ROLES,
  ROLE_CATALOGUE,
  NIGHT_ORDER,
  NIGHT_ACTORS,
  assignRoles,
  checkWinCondition,
  getNextNightActor,
  resolveMafiaVotes,
  resolveNightActions,
  resolveVotesPure,
  validateCustomRoles,
  getRoleDescription,
};
