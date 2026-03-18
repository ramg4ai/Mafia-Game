const {
  assignRoles,
  checkWinCondition,
  getNextNightActor,
  resolveMafiaVotes,
  resolveNightActions,
  ROLES,
  ROLE_CATALOGUE,
} = require('./server');

describe('Server Game Logic', () => {

  describe('assignRoles', () => {
    it('should assign exactly 6 roles for 6 players', () => {
      const roles = assignRoles(6);
      expect(roles.length).toBe(6);
      expect(roles.filter(r => r === 'MAFIA').length).toBe(2);
      expect(roles).toContain('DOCTOR');
      expect(roles).toContain('POLICE');
      expect(roles).toContain('CIVILIAN');
      expect(roles).toContain('JOKER');
    });

    it('should assign correctly for 10 players', () => {
      const roles = assignRoles(10);
      expect(roles.length).toBe(10);
      expect(roles.filter(r => r === 'MAFIA').length).toBe(2);
      expect(roles).toContain('TRAITOR');
      expect(roles).toContain('VIGILANTE');
      expect(roles).toContain('JESTER');
      expect(roles.filter(r => r === 'CIVILIAN').length).toBe(2);
    });
  });

  describe('checkWinCondition', () => {
    it('should return Mafia win if no Civilians are left', () => {
      const room = {
        players: [
          { role: 'MAFIA', alive: true },
          { role: 'CIVILIAN', alive: false }
        ]
      };
      const result = checkWinCondition(room);
      expect(result).toEqual({ winner: 'Mafia', reason: 'All Civilians have been eliminated' });
    });

    it('should return Civilians win if no Mafia are left', () => {
      const room = {
        players: [
          { role: 'MAFIA', alive: false },
          { role: 'CIVILIAN', alive: true }
        ]
      };
      const result = checkWinCondition(room);
      expect(result).toEqual({ winner: 'Civilians', reason: 'All Mafia have been eliminated' });
    });

    it('should return Neutrals win if no Mafia and no Civilians are left', () => {
      const room = {
        players: [
          { role: 'MAFIA', alive: false },
          { role: 'CIVILIAN', alive: false },
          { role: 'JOKER', alive: true }
        ]
      };
      const result = checkWinCondition(room);
      expect(result).toEqual({ winner: 'Neutrals', reason: 'Only Neutrals remain' });
    });

    it('should return null if game continues', () => {
      const room = {
        players: [
          { role: 'MAFIA', alive: true },
          { role: 'CIVILIAN', alive: true },
          { role: 'JOKER', alive: true }
        ]
      };
      const result = checkWinCondition(room);
      expect(result).toBeNull();
    });
  });

  describe('resolveMafiaVotes', () => {
    it('should return target if clear majority', () => {
      const votes = { 'p1': 'targetA', 'p2': 'targetA', 'p3': 'targetB' };
      expect(resolveMafiaVotes(votes)).toBe('targetA');
    });

    it('should return null on tie', () => {
      const votes = { 'p1': 'targetA', 'p2': 'targetB' };
      expect(resolveMafiaVotes(votes)).toBeNull();
    });

    it('should return null if no votes', () => {
      expect(resolveMafiaVotes({})).toBeNull();
    });
  });

  describe('resolveNightActions', () => {
    let room;
    beforeEach(() => {
      room = {
        code: 'TEST',
        players: [
          { id: 'm1', name: 'Mafia1', role: 'MAFIA', alive: true },
          { id: 'c1', name: 'Civ1', role: 'CIVILIAN', alive: true },
          { id: 'd1', name: 'Doc1', role: 'DOCTOR', alive: true },
          { id: 'v1', name: 'Vig1', role: 'VIGILANTE', alive: true },
          { id: 'j1', name: 'Joker1', role: 'JOKER', alive: true }
        ],
        nightActions: {
          mafiaKill: null,
          doctorSaves: [],
          jokerActions: [],
          vigilanteKills: [],
          policeInvestigations: []
        },
        ghostGuesses: {}
      };
    });

    it('should eliminate target if mafia votes and no doctor saves', () => {
      room.nightActions.mafiaKill = 'c1';
      const res = resolveNightActions(room);
      expect(res.eliminated).toContain('Civ1');
      const civ = room.players.find(p => p.id === 'c1');
      expect(civ.alive).toBe(false);
    });

    it('should save target if doctor saves them', () => {
      room.nightActions.mafiaKill = 'c1';
      room.nightActions.doctorSaves.push({ playerId: 'd1', targetId: 'c1' });
      const res = resolveNightActions(room);
      expect(res.eliminated).not.toContain('Civ1');
      const civ = room.players.find(p => p.id === 'c1');
      expect(civ.alive).toBe(true);
    });

    it('should let joker protect cancel mafia kill', () => {
      room.nightActions.mafiaKill = 'c1';
      room.nightActions.jokerActions.push({ playerId: 'j1', action: 'protect', targetId: 'c1' });
      const res = resolveNightActions(room);
      expect(res.eliminated).not.toContain('Civ1');
    });

    it('should let joker kill target if no protect', () => {
      room.nightActions.jokerActions.push({ playerId: 'j1', action: 'kill', targetId: 'c1' });
      const res = resolveNightActions(room);
      expect(res.eliminated).toContain('Civ1');
    });

    it('should apply vigilante kill but backfire if target is civilian', () => {
      // Vig kills Civilian
      room.nightActions.vigilanteKills.push({ playerId: 'v1', targetId: 'c1' });
      const res = resolveNightActions(room);
      expect(res.eliminated).toContain('Vig1'); // backfires
      expect(res.eliminated).not.toContain('Civ1'); // target survives
    });

    it('should apply vigilante kill properly to mafia', () => {
      // Vig kills Mafia
      room.nightActions.vigilanteKills.push({ playerId: 'v1', targetId: 'm1' });
      const res = resolveNightActions(room);
      expect(res.eliminated).toContain('Mafia1');
      expect(res.eliminated).not.toContain('Vig1');
    });
  });

  describe('getNextNightActor', () => {
    it('should return MAFIA_GROUP if mafia has not acted', () => {
      const room = {
        players: [{ id: 'm1', role: 'MAFIA', alive: true }],
        nightActed: new Set()
      };
      const act = getNextNightActor(room);
      expect(act.role).toBe('MAFIA_GROUP');
      expect(act.players[0].id).toBe('m1');
    });

    it('should return DOCTOR next if mafia group already acted', () => {
      const room = {
        players: [
          { id: 'm1', role: 'MAFIA', alive: true },
          { id: 'd1', role: 'DOCTOR', alive: true }
        ],
        nightActed: new Set(['MAFIA_GROUP'])
      };
      const act = getNextNightActor(room);
      expect(act.role).toBe('DOCTOR');
    });

    it('should return null if everyone has acted', () => {
      const room = {
        players: [
          { id: 'm1', role: 'MAFIA', alive: true }
        ],
        nightActed: new Set(['MAFIA_GROUP'])
      };
      const act = getNextNightActor(room);
      expect(act).toBeNull();
    });
  });
});
