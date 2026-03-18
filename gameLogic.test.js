'use strict';
const {
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
} = require('./gameLogic');

// ─── Shared fixture factory ───────────────────────────────────────────────────
function makePlayer(overrides = {}) {
  return {
    id: `p-${Math.random()}`,
    name: 'Player',
    role: 'CIVILIAN',
    alive: true,
    killFlagged: false,
    isHost: false,
    ...overrides,
  };
}

function makeRoom(overrides = {}) {
  return {
    code: 'TEST',
    players: [],
    nightActed: new Set(),
    nightActions: {
      mafiaKill: null,
      mafiaVotes: {},
      doctorSaves: [],
      policeInvestigations: [],
      jokerActions: [],
      vigilanteKills: [],
    },
    nightActedPlayers: new Set(),
    ghostGuesses: {},
    votes: {},
    voteLog: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLES constant
// ─────────────────────────────────────────────────────────────────────────────
describe('ROLES constant', () => {
  const expectedRoles = ['MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JESTER', 'JOKER', 'CIVILIAN'];

  test('exports all 8 roles', () => {
    expect(Object.keys(ROLES)).toHaveLength(8);
    for (const r of expectedRoles) expect(ROLES[r]).toBeDefined();
  });

  test('mafia group contains MAFIA and TRAITOR', () => {
    expect(ROLES.MAFIA.group).toBe('mafia');
    expect(ROLES.TRAITOR.group).toBe('mafia');
  });

  test('civilian group is correct', () => {
    ['DOCTOR', 'POLICE', 'VIGILANTE', 'CIVILIAN'].forEach(r =>
      expect(ROLES[r].group).toBe('civilian')
    );
  });

  test('neutral group is correct', () => {
    ['JOKER', 'JESTER'].forEach(r => expect(ROLES[r].group).toBe('neutral'));
  });

  test('special flags are set correctly', () => {
    expect(ROLES.TRAITOR.special).toBe(true);
    expect(ROLES.VIGILANTE.special).toBe(true);
    expect(ROLES.JESTER.special).toBe(true);
    expect(ROLES.MAFIA.special).toBe(false);
    expect(ROLES.CIVILIAN.special).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROLE_CATALOGUE
// ─────────────────────────────────────────────────────────────────────────────
describe('ROLE_CATALOGUE', () => {
  test('mafia group lists MAFIA and TRAITOR', () => {
    expect(ROLE_CATALOGUE.mafia).toEqual(expect.arrayContaining(['MAFIA', 'TRAITOR']));
  });

  test('civilian group lists all civilian roles', () => {
    expect(ROLE_CATALOGUE.civilian).toEqual(
      expect.arrayContaining(['CIVILIAN', 'DOCTOR', 'POLICE', 'VIGILANTE'])
    );
  });

  test('neutral group lists JOKER and JESTER', () => {
    expect(ROLE_CATALOGUE.neutral).toEqual(expect.arrayContaining(['JOKER', 'JESTER']));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NIGHT_ORDER / NIGHT_ACTORS
// ─────────────────────────────────────────────────────────────────────────────
describe('NIGHT_ORDER and NIGHT_ACTORS', () => {
  test('NIGHT_ORDER starts with MAFIA', () => {
    expect(NIGHT_ORDER[0]).toBe('MAFIA');
  });

  test('CIVILIAN and JESTER are excluded from NIGHT_ACTORS', () => {
    expect(NIGHT_ACTORS.has('CIVILIAN')).toBe(false);
    expect(NIGHT_ACTORS.has('JESTER')).toBe(false);
  });

  test('all roles in NIGHT_ORDER are in NIGHT_ACTORS', () => {
    for (const r of NIGHT_ORDER) expect(NIGHT_ACTORS.has(r)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assignRoles
// ─────────────────────────────────────────────────────────────────────────────
describe('assignRoles', () => {
  const compositions = {
    6:  { MAFIA: 2, DOCTOR: 1, POLICE: 1, CIVILIAN: 1, JOKER: 1 },
    7:  { MAFIA: 2, DOCTOR: 1, POLICE: 1, CIVILIAN: 2, JOKER: 1 },
    8:  { MAFIA: 3, DOCTOR: 1, POLICE: 1, CIVILIAN: 2, JOKER: 1 },
    9:  { MAFIA: 2, TRAITOR: 1, DOCTOR: 1, POLICE: 1, CIVILIAN: 3, JOKER: 1 },
    10: { MAFIA: 2, TRAITOR: 1, DOCTOR: 1, POLICE: 1, VIGILANTE: 1, CIVILIAN: 2, JOKER: 1, JESTER: 1 },
  };

  for (const [count, expected] of Object.entries(compositions)) {
    test(`${count} players → correct composition`, () => {
      const roles = assignRoles(Number(count));
      expect(roles).toHaveLength(Number(count));
      const tally = {};
      for (const r of roles) tally[r] = (tally[r] || 0) + 1;
      for (const [role, n] of Object.entries(expected)) {
        expect(tally[role]).toBe(n);
      }
    });
  }

  test('all role keys are valid ROLES entries', () => {
    for (const n of [6, 7, 8, 9, 10]) {
      const roles = assignRoles(n);
      roles.forEach(r => expect(ROLES[r]).toBeDefined());
    }
  });

  test('returns empty array for unsupported player count', () => {
    expect(assignRoles(5)).toHaveLength(0);
    expect(assignRoles(11)).toHaveLength(0);
    expect(assignRoles(0)).toHaveLength(0);
  });

  test('shuffles roles (composition preserved, at least some variance)', () => {
    // Run 20 times; the order should not be identical every time
    const first = assignRoles(10).join(',');
    const different = Array.from({ length: 20 }, () => assignRoles(10).join(','));
    expect(different.some(o => o !== first)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkWinCondition
// ─────────────────────────────────────────────────────────────────────────────
describe('checkWinCondition', () => {
  function room(...players) { return { players }; }
  const M  = (alive = true) => makePlayer({ role: 'MAFIA',    alive });
  const C  = (alive = true) => makePlayer({ role: 'CIVILIAN', alive });
  const N  = (alive = true) => makePlayer({ role: 'JOKER',    alive });

  test('no Civilians → Mafia wins', () => {
    const r = checkWinCondition(room(M(), C(false)));
    expect(r).toEqual({ winner: 'Mafia', reason: 'All Civilians have been eliminated' });
  });

  test('no Mafia → Civilians win', () => {
    const r = checkWinCondition(room(M(false), C()));
    expect(r).toEqual({ winner: 'Civilians', reason: 'All Mafia have been eliminated' });
  });

  test('only Neutrals remain → Neutrals win', () => {
    const r = checkWinCondition(room(M(false), C(false), N()));
    expect(r).toEqual({ winner: 'Neutrals', reason: 'Only Neutrals remain' });
  });

  test('1 Civilian with Neutral → game continues', () => {
    expect(checkWinCondition(room(M(), C(), N()))).toBeNull();  // 2 civs
    expect(checkWinCondition(room(M(), C(false), C(), N()))).toBeNull(); // 1 civ + neutral
  });

  test('1 Civilian, no Neutrals → Mafia wins (outnumber)', () => {
    const r = checkWinCondition(room(M(), C(), C(false)));
    expect(r).toEqual({ winner: 'Mafia', reason: 'Mafia outnumbers the last Civilian' });
  });

  test('normal game with several alive → continues', () => {
    expect(checkWinCondition(room(M(), M(), C(), C(), N()))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveMafiaVotes
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveMafiaVotes', () => {
  test('no votes → null', () => {
    expect(resolveMafiaVotes({})).toBeNull();
  });

  test('single voter → wins outright', () => {
    expect(resolveMafiaVotes({ p1: 'targetA' })).toBe('targetA');
  });

  test('clear majority → returns winner', () => {
    const votes = { p1: 'A', p2: 'A', p3: 'B' };
    expect(resolveMafiaVotes(votes)).toBe('A');
  });

  test('tie → null', () => {
    expect(resolveMafiaVotes({ p1: 'A', p2: 'B' })).toBeNull();
  });

  test('three-way tie → null', () => {
    expect(resolveMafiaVotes({ p1: 'A', p2: 'B', p3: 'C' })).toBeNull();
  });

  test('2 for A, 2 for B → tie → null', () => {
    expect(resolveMafiaVotes({ p1: 'A', p2: 'A', p3: 'B', p4: 'B' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveNightActions
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveNightActions', () => {
  let room;
  let mafia, civ, doc, vig, joker, traitor;

  beforeEach(() => {
    mafia   = makePlayer({ id: 'm1', name: 'Mafia1',   role: 'MAFIA' });
    traitor = makePlayer({ id: 'tr', name: 'Traitor1', role: 'TRAITOR' });
    civ     = makePlayer({ id: 'c1', name: 'Civ1',     role: 'CIVILIAN' });
    doc     = makePlayer({ id: 'd1', name: 'Doc1',     role: 'DOCTOR' });
    vig     = makePlayer({ id: 'v1', name: 'Vig1',     role: 'VIGILANTE' });
    joker   = makePlayer({ id: 'j1', name: 'Joker1',   role: 'JOKER' });

    room = makeRoom({ players: [mafia, traitor, civ, doc, vig, joker] });
  });

  describe('mafia kill', () => {
    test('kills target when no saves', () => {
      room.nightActions.mafiaKill = 'c1';
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toContain('Civ1');
      expect(civ.alive).toBe(false);
    });

    test('no kill when mafiaKill is null', () => {
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toHaveLength(0);
    });

    test('no kill when mafiaKill target id is invalid', () => {
      room.nightActions.mafiaKill = 'nonexistent';
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toHaveLength(0);
    });
  });

  describe('doctor save', () => {
    test('doctor save cancels mafia kill', () => {
      room.nightActions.mafiaKill = 'c1';
      room.nightActions.doctorSaves.push({ playerId: 'd1', targetId: 'c1' });
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).not.toContain('Civ1');
      expect(civ.alive).toBe(true);
    });

    test('doctor save on non-targeted player has no effect', () => {
      room.nightActions.mafiaKill = 'c1';
      room.nightActions.doctorSaves.push({ playerId: 'd1', targetId: 'm1' }); // saves mafia, not victim
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toContain('Civ1');
    });

    test('multiple doctors can save different targets', () => {
      const doc2 = makePlayer({ id: 'd2', name: 'Doc2', role: 'DOCTOR' });
      room.players.push(doc2);
      room.nightActions.mafiaKill = 'c1';
      room.nightActions.doctorSaves.push(
        { playerId: 'd1', targetId: 'c1' },
        { playerId: 'd2', targetId: 'c1' }
      );
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toHaveLength(0);
    });
  });

  describe('joker actions', () => {
    test('joker kill eliminates target', () => {
      room.nightActions.jokerActions.push({ playerId: 'j1', action: 'kill', targetId: 'c1' });
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toContain('Civ1');
    });

    test('joker protect cancels mafia kill on same target', () => {
      room.nightActions.mafiaKill = 'c1';
      room.nightActions.jokerActions.push({ playerId: 'j1', action: 'protect', targetId: 'c1' });
      const { eliminated, events } = resolveNightActions(room);
      expect(eliminated).toHaveLength(0);
      expect(events.some(e => e.type === 'save')).toBe(true);
    });

    test('joker protect cancels joker kill on same target', () => {
      const joker2 = makePlayer({ id: 'j2', name: 'Joker2', role: 'JOKER' });
      room.players.push(joker2);
      room.nightActions.jokerActions.push(
        { playerId: 'j1', action: 'kill',    targetId: 'c1' },
        { playerId: 'j2', action: 'protect', targetId: 'c1' }
      );
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toHaveLength(0);
    });

    test('joker protect on un-killed target adds no events', () => {
      room.nightActions.jokerActions.push({ playerId: 'j1', action: 'protect', targetId: 'c1' });
      const { events } = resolveNightActions(room);
      expect(events).toHaveLength(0);
    });
  });

  describe('vigilante', () => {
    test('kills mafia target correctly', () => {
      room.nightActions.vigilanteKills.push({ playerId: 'v1', targetId: 'm1' });
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toContain('Mafia1');
      expect(eliminated).not.toContain('Vig1');
    });

    test('backfires when targeting civilian', () => {
      room.nightActions.vigilanteKills.push({ playerId: 'v1', targetId: 'c1' });
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toContain('Vig1');
      expect(eliminated).not.toContain('Civ1');
    });

    test('backfires when targeting another civilian role (Doctor)', () => {
      room.nightActions.vigilanteKills.push({ playerId: 'v1', targetId: 'd1' });
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toContain('Vig1');
      expect(eliminated).not.toContain('Doc1');
    });

    test('multiple vigilantes each resolve independently', () => {
      const vig2 = makePlayer({ id: 'v2', name: 'Vig2', role: 'VIGILANTE' });
      room.players.push(vig2);
      room.nightActions.vigilanteKills.push(
        { playerId: 'v1', targetId: 'm1' }, // kills Mafia
        { playerId: 'v2', targetId: 'c1' }  // backfires
      );
      const { eliminated } = resolveNightActions(room);
      expect(eliminated).toContain('Mafia1');
      expect(eliminated).toContain('Vig2');
      expect(eliminated).not.toContain('Civ1');
    });
  });

  describe('traitor dies → leaves mafia channel via ioStub', () => {
    test('calls leave on ioStub when mafia-group player dies', () => {
      const leaveFn = jest.fn();
      const ioStub = { sockets: { sockets: { get: () => ({ leave: leaveFn }) } } };
      room.nightActions.mafiaKill = 'tr';
      resolveNightActions(room, ioStub);
      expect(leaveFn).toHaveBeenCalledWith(`mafia-${room.code}`);
    });

    test('works without ioStub (default no-op)', () => {
      room.nightActions.mafiaKill = 'tr';
      expect(() => resolveNightActions(room)).not.toThrow();
    });
  });

  describe('ghost guesses', () => {
    test('correct ghost guess (none happened and guessed none)', () => {
      room.ghostGuesses = { 'd1': 'none' };
      const { correctGuessers } = resolveNightActions(room);
      expect(correctGuessers).toContain('Doc1');
    });

    test('correct ghost guess (guessed the eliminated player)', () => {
      room.nightActions.mafiaKill = 'c1';
      room.ghostGuesses = { 'd1': 'c1' };
      const { correctGuessers } = resolveNightActions(room);
      expect(correctGuessers).toContain('Doc1');
    });

    test('wrong ghost guess (guessed nobody but someone died)', () => {
      room.nightActions.mafiaKill = 'c1';
      room.ghostGuesses = { 'd1': 'none' };
      const { correctGuessers } = resolveNightActions(room);
      expect(correctGuessers).not.toContain('Doc1');
    });

    test('ghost guesser with unknown playerId is skipped', () => {
      room.ghostGuesses = { 'unknown-id': 'none' };
      const { correctGuessers } = resolveNightActions(room);
      expect(correctGuessers).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNextNightActor
// ─────────────────────────────────────────────────────────────────────────────
describe('getNextNightActor', () => {
  test('MAFIA_GROUP is first when mafia alive', () => {
    const room = makeRoom({
      players: [makePlayer({ role: 'MAFIA', alive: true })],
    });
    const act = getNextNightActor(room);
    expect(act.role).toBe('MAFIA_GROUP');
    expect(act.isGhost).toBe(false);
  });

  test('MAFIA_GROUP is ghost when all mafia dead', () => {
    const room = makeRoom({
      players: [makePlayer({ role: 'MAFIA', alive: false })],
    });
    const act = getNextNightActor(room);
    expect(act.role).toBe('MAFIA_GROUP');
    expect(act.isGhost).toBe(true);
  });

  test('MAFIA_GROUP is skipped if already acted', () => {
    const room = makeRoom({
      players: [
        makePlayer({ role: 'MAFIA',   alive: true }),
        makePlayer({ role: 'DOCTOR',  alive: true }),
      ],
      nightActed: new Set(['MAFIA_GROUP']),
    });
    const act = getNextNightActor(room);
    expect(act.role).toBe('DOCTOR');
  });

  test('TRAITOR is included in MAFIA_GROUP turn', () => {
    const room = makeRoom({
      players: [
        makePlayer({ id: 'm1', role: 'MAFIA',   alive: true }),
        makePlayer({ id: 'tr', role: 'TRAITOR',  alive: true }),
      ],
    });
    const act = getNextNightActor(room);
    expect(act.role).toBe('MAFIA_GROUP');
    expect(act.players).toHaveLength(2);
  });

  test('night order: MAFIA_GROUP → DOCTOR → POLICE → VIGILANTE → JOKER', () => {
    const players = [
      makePlayer({ role: 'MAFIA',     alive: true }),
      makePlayer({ role: 'DOCTOR',    alive: true }),
      makePlayer({ role: 'POLICE',    alive: true }),
      makePlayer({ role: 'VIGILANTE', alive: true }),
      makePlayer({ role: 'JOKER',     alive: true }),
    ];
    const room = makeRoom({ players });
    const order = [];
    let actor;
    while ((actor = getNextNightActor(room)) !== null) {
      order.push(actor.role);
    }
    expect(order).toEqual(['MAFIA_GROUP', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JOKER']);
  });

  test('roles with no alive AND no dead players are skipped entirely', () => {
    const room = makeRoom({
      players: [makePlayer({ role: 'MAFIA', alive: true })],
    });
    // MAFIA_GROUP acts; DOCTOR has no players — should return null
    getNextNightActor(room); // consume MAFIA_GROUP
    const next = getNextNightActor(room);
    expect(next).toBeNull();
  });

  test('returns null when all actors have gone', () => {
    const room = makeRoom({
      players: [makePlayer({ role: 'MAFIA', alive: true })],
      nightActed: new Set(['MAFIA_GROUP']),
    });
    expect(getNextNightActor(room)).toBeNull();
  });

  test('multiple players of same role are grouped into one turn', () => {
    const room = makeRoom({
      players: [
        makePlayer({ id: 'd1', role: 'DOCTOR', alive: true }),
        makePlayer({ id: 'd2', role: 'DOCTOR', alive: true }),
      ],
      nightActed: new Set(['MAFIA_GROUP']),
    });
    const act = getNextNightActor(room);
    expect(act.role).toBe('DOCTOR');
    expect(act.players).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveVotesPure
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveVotesPure', () => {
  let room;
  let alice, bob, charlie;

  beforeEach(() => {
    alice   = makePlayer({ id: 'a', name: 'Alice',   role: 'CIVILIAN' });
    bob     = makePlayer({ id: 'b', name: 'Bob',     role: 'MAFIA' });
    charlie = makePlayer({ id: 'c', name: 'Charlie', role: 'CIVILIAN' });
    room = makeRoom({ players: [alice, bob, charlie] });
  });

  test('all vote for same player → elimination', () => {
    room.votes = { a: 'b', c: 'b' };
    room.voteLog = [
      { voterName: 'Alice', targetName: 'Bob' },
      { voterName: 'Charlie', targetName: 'Bob' },
    ];
    const result = resolveVotesPure(room);
    expect(result.eliminatedId).toBe('b');
    expect(result.eliminatedName).toBe('Bob');
    expect(result.tie).toBe(false);
    expect(result.jesterWin).toBe(false);
    expect(bob.alive).toBe(false);
  });

  test('tied vote → no elimination', () => {
    room.votes = { a: 'b', c: 'a' };
    const result = resolveVotesPure(room);
    expect(result.eliminatedId).toBeNull();
    expect(result.tie).toBe(true);
  });

  test('skip votes outnumber player votes → skippedOverride', () => {
    // 1 vote for Bob, 2 explicit skips
    room.votes = { a: 'b', b: 'null', c: 'null' };
    const result = resolveVotesPure(room);
    expect(result.skippedOverride).toBe(true);
    expect(result.eliminatedId).toBeNull();
  });

  test('no votes at all → no elimination, tie=true (zero candidates ≠ one)', () => {
    room.votes = {};
    const result = resolveVotesPure(room);
    expect(result.eliminatedId).toBeNull();
    expect(result.tie).toBe(true); // 0 candidates means topCandidates.length !== 1
  });

  test('Jester voted out → jesterWin = true, Jester stays alive', () => {
    const jester = makePlayer({ id: 'j', name: 'Jest', role: 'JESTER' });
    room.players.push(jester);
    // all 3 others vote for jester
    room.votes = { a: 'j', b: 'j', c: 'j' };
    const result = resolveVotesPure(room);
    expect(result.jesterWin).toBe(true);
    expect(result.eliminatedId).toBe('j');
    expect(jester.alive).toBe(true); // Jester not marked dead by this function
  });

  test('player who never voted is counted as skip', () => {
    // Alice votes for Bob; Charlie never votes (no-vote = skip)
    // Result: 1 vote for Bob vs 1 implicit skip → skippedOverride
    room.votes = { a: 'b' }; // Charlie doesn't vote
    const result = resolveVotesPure(room);
    expect(result.skippedOverride).toBe(true);
    expect(result.noVoteNames).toContain('Charlie');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCustomRoles
// ─────────────────────────────────────────────────────────────────────────────
describe('validateCustomRoles', () => {
  const valid = ['MAFIA', 'MAFIA', 'CIVILIAN', 'CIVILIAN', 'DOCTOR', 'JOKER'];

  test('valid assignment returns { valid: true }', () => {
    expect(validateCustomRoles(valid, 6)).toEqual({ valid: true });
  });

  test('too few roles → invalid', () => {
    const result = validateCustomRoles(['MAFIA', 'CIVILIAN'], 6);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/count/i);
  });

  test('too many roles → invalid', () => {
    const result = validateCustomRoles([...valid, 'JOKER'], 6);
    expect(result.valid).toBe(false);
  });

  test('null/undefined list → invalid', () => {
    const result = validateCustomRoles(null, 6);
    expect(result.valid).toBe(false);
  });

  test('unknown role key → invalid', () => {
    const roles = [...valid.slice(0, 5), 'WIZARD'];
    const result = validateCustomRoles(roles, 6);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unknown role/i);
  });

  test('fewer than 2 mafia → invalid', () => {
    const roles = ['MAFIA', 'CIVILIAN', 'CIVILIAN', 'DOCTOR', 'JOKER', 'JESTER'];
    const result = validateCustomRoles(roles, 6);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/2 Mafia/i);
  });

  test('fewer than 2 civilians → invalid', () => {
    const roles = ['MAFIA', 'MAFIA', 'TRAITOR', 'CIVILIAN', 'JOKER', 'JESTER'];
    const result = validateCustomRoles(roles, 6);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/2 Civilian/i);
  });

  test('exactly 2 mafia and 2 civilian → valid', () => {
    expect(validateCustomRoles(valid, 6)).toEqual({ valid: true });
  });

  test('large custom set (20 players) passes when valid', () => {
    const large = [
      ...Array(4).fill('MAFIA'),
      ...Array(8).fill('CIVILIAN'),
      'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JOKER', 'JESTER', 'JOKER', 'JESTER'
    ];
    expect(large).toHaveLength(20);
    expect(validateCustomRoles(large, 20)).toEqual({ valid: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRoleDescription
// ─────────────────────────────────────────────────────────────────────────────
describe('getRoleDescription', () => {
  const roles = ['MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JESTER', 'JOKER', 'CIVILIAN'];

  test.each(roles)('%s has a non-empty description', (role) => {
    const desc = getRoleDescription(role);
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(10);
  });

  test('unknown role returns empty string', () => {
    expect(getRoleDescription('WIZARD')).toBe('');
  });
});
