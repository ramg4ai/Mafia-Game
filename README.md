# 🎭 Mafia Game

A real-time multiplayer Mafia party game built with **Node.js**, **Express**, and **Socket.IO**. Players join a shared room, are secretly assigned roles, and take turns during night and day phases until one faction wins.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express 4, Socket.IO 4 |
| Frontend | Vanilla HTML5, CSS3, JavaScript (no framework) |
| Real-time | WebSockets via Socket.IO |
| Styling | Custom CSS with CSS variables, glassmorphism |

---

## Project Structure

```
Mafia Game/
├── server.js              # Networking shell: Socket.IO event handlers & timers
├── gameLogic.js           # Pure game logic (roles, win conditions, night resolution)
├── gameLogic.test.js      # Jest unit tests — 83 tests, ~98% coverage of gameLogic.js
├── package.json
└── public/
    ├── index.html         # Single-page app (all screens in one file)
    ├── css/
    │   └── style.css      # All styles (dark theme, animations, responsive)
    └── js/
        └── app.js         # Client-side state, socket event handlers, UI logic
```

---

## Getting Started

```bash
npm install
npm start
# → Server running at http://localhost:3000
```

For LAN multi-player: share your local IP address with players on the same network.  
For remote play: use `npx ngrok http 3000` to get a public URL.

---

## Core Game Constants (`gameLogic.js`)

All pure game logic lives in `gameLogic.js` and is imported by `server.js`. Always update these when adding new roles or changing game mechanics.

### `ROLES` — Role definitions
```js
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
```

### `NIGHT_ORDER` — Turn order for night phase
```js
const NIGHT_ORDER = ['MAFIA', 'TRAITOR', 'DOCTOR', 'POLICE', 'VIGILANTE', 'JOKER'];
```
> MAFIA and TRAITOR are collapsed into a single `MAFIA_GROUP` turn.  
> CIVILIAN and JESTER have no night action and are never called.

### `ROLE_CATALOGUE` — Used by the Custom Role Picker UI
```js
const ROLE_CATALOGUE = {
  mafia:    ['MAFIA', 'TRAITOR'],
  civilian: ['CIVILIAN', 'DOCTOR', 'POLICE', 'VIGILANTE'],
  neutral:  ['JOKER', 'JESTER'],
};
```

---

## Role Guide

### Mafia Group (win by eliminating all Civilians)
| Role | Night Ability |
|------|--------------|
| **Mafia** | Vote with team to eliminate one player |
| **Traitor** | Same as Mafia; appears as **Civilian** to Police investigation |

### Civilian Group (win by eliminating all Mafia)
| Role | Night Ability |
|------|--------------|
| **Civilian** | No night ability |
| **Doctor** | Protect one player from elimination |
| **Police** | Investigate one player; learn their **group** (Mafia / Civilian / Neutral) |
| **Vigilante** | Kill one player; if target is Civilian, Vigilante dies instead (backfire) |

### Neutral Group (win conditions vary)
| Role | Night Ability | Win Condition |
|------|--------------|---------------|
| **Joker** | Kill, protect, or investigate one player | Survival |
| **Jester** | None | Get voted out during the Day phase |

---

## Game Modes

### Auto Mode (default)
- **Players:** 6–10
- Roles assigned automatically by `assignRoles(playerCount)` in `server.js`
- Predefined compositions per player count (6–10)

### Custom Mode
- **Players:** 6–20
- Host clicks **Pick Roles** (locks the room to new joiners)
- Host selects role counts from three sections: **Mafia House**, **Civilian Town**, **Neutrals**
- Validation enforced: total roles must equal player count; min 2 Mafia, min 2 Civilian
- Server validates custom assignments before game starts

---

## Game Flow

```
Lobby (waiting room)
  └─ host sets mode, timers, starts game
       └─ Role Reveal (each player sees their role privately)
            └─ Night Phase (repeating rounds)
            │    ├─ Mafia Group votes to kill
            │    ├─ Doctor protects
            │    ├─ Police investigates
            │    ├─ Vigilante acts
            │    └─ Joker acts
            └─ Day Phase
                 ├─ Discussion (configurable timer: 1–5 min)
                 └─ Voting (30 s default)
                      └─ Player eliminated or tied/skipped
                           └─ Check win condition → repeat or Game Over
```

---

## Host Controls (Waiting Room)

| Control | Description |
|---------|-------------|
| Role Selector toggle | Switch between Auto / Custom mode |
| Discussion timer | 1–5 minutes (default 3 min) |
| Night timer | 10–120 seconds in 10-second steps (default 30 s) |
| Vote timer | 30 seconds (currently fixed) |
| Start Game / Pick Roles | Start the game (Auto) or open role picker (Custom) |

> **Only the host sees these controls.** Other players see the player list and a waiting hint.

---

## Night Phase Logic (`gameLogic.js`)

- `getNextNightActor(room)` — returns the next role group that should act. MAFIA + TRAITOR are merged into one `MAFIA_GROUP` turn. Multiple players sharing the same role all act simultaneously.
- `resolveNightActions(room, io?)` — processes all submitted actions. Priority: Doctor save > Mafia kill. Joker protect cancels kills on the same target. Accepts an optional `io` stub for testability.
- `resolveVotesPure(room)` — pure day-vote resolution returning a result object; called by `resolveVotes` in `server.js`.
- `room.nightActedPlayers` — Set of socket IDs tracking per-player action completion within a shared-role turn.

---

## Day Phase Logic

- Discussion runs for `room.discussionMinutes` minutes.
- Voting runs for `room.voteSeconds` seconds.
- A player is eliminated only if they have a **strict majority** of votes AND their votes exceed the total Skip Vote count.
- Tied votes and Skip Vote majority both result in no elimination.
- **Jester special rule:** If the Jester is voted out, Jester immediately wins.

---

## Win Conditions

| Condition | Winner |
|-----------|--------|
| All Mafia eliminated | Civilians |
| All Civilians eliminated | Mafia |
| Only Neutrals remain | Neutrals |
| Mafia ≥ Civilians (no Neutrals) | Mafia |
| Jester voted out during Day phase | Jester |

---

## Police Investigation

Police (and Joker in investigate mode) reveals only the **group** of the target — `Mafia`, `Civilian`, or `Neutral`. The specific role is never revealed.

> **Traitor appears as Civilian** to Police investigation.

---

## Known Design Decisions

- Players who disconnect during a game are **immediately removed** (lobby) or **marked dead** (mid-game). There is no reconnection grace period currently.
- The role sidebar is hidden until the player flips their role card.
- Dead players can participate as **ghosts**: they guess who the Mafia will kill each night, scored for correct predictions.
- The player count badge (e.g. `2/10`) is visible only to the host.

---

## Adding a New Role

1. Add an entry to `ROLES` in **`gameLogic.js`**.
2. Add the role to the appropriate group in `ROLE_CATALOGUE` in `gameLogic.js`.
3. If the role has a night action, add it to `NIGHT_ORDER` and `NIGHT_ACTORS` in `gameLogic.js`.
4. Implement the server-side socket handler in `server.js` (e.g. `socket.on('new-role-action', ...)`).
5. Add night action resolution logic in `resolveNightActions` in `gameLogic.js`.
6. Update `getRoleDescription` in `gameLogic.js`.
7. Add the role icon to `ROLE_ICONS` in `public/js/app.js`.
8. Add client-side handler for `your-night-turn` in `app.js` (titles/descriptions).
9. Add corresponding unit tests in `gameLogic.test.js`.

---

## Testing

```bash
npm test                # Run all tests with coverage report
npm run test:watch      # Watch mode for TDD
```

Tests live in `gameLogic.test.js` and cover all exported functions from `gameLogic.js`:

| Group | Tests |
|-------|-------|
| `ROLES` / `ROLE_CATALOGUE` / `NIGHT_ORDER` | Constants validation |
| `assignRoles` | Correct composition for 6–10 players; shuffle variance |
| `checkWinCondition` | All 5 win/continue scenarios |
| `resolveMafiaVotes` | Majority, tie, no votes |
| `resolveNightActions` | Kill, save, joker kill/protect, vigilante backfire, ghost guesses, io stub |
| `getNextNightActor` | Turn ordering, ghost path, multiple players per role |
| `resolveVotesPure` | Elimination, tie, skip-override, Jester win |
| `validateCustomRoles` | Valid/invalid role sets |
| `getRoleDescription` | All 8 roles have descriptions |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
