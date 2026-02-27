/* ─────────────────────────────────────────────────────────────────────────────
   Mafia Game — Client JavaScript
   app.js: Socket connection, state management, screen routing, all events
────────────────────────────────────────────────────────────────────────────── */

const socket = io();

// ─── Client State ──────────────────────────────────────────────────────────
const state = {
    roomCode: null,
    myName: null,
    myRole: null,
    myRoleKey: null,
    myGroup: null,
    isHost: false,
    isMafia: false,
    discussionMinutes: 3,
    nightPhaseSeconds: 30,
    voteSeconds: 30,
    currentNightRole: null,
    selectedTarget: null,
    allTargets: [],      // full target list including self (for Joker re-render)
    jokerAction: 'kill',
    hasVoted: false,
    isAlive: true,
    players: [],
    mafiaAlliesHtml: null,
    mafiaAlliesSidebarHtml: null,
};

// ─── Role visuals ───────────────────────────────────────────────────────────
const ROLE_ICONS = {
    MAFIA: '🔪', TRAITOR: '🎭', DOCTOR: '💉', POLICE: '🔍',
    VIGILANTE: '🔫', JESTER: '🃏', JOKER: '🃏', CIVILIAN: '🧑',
};
const COLOR_PALETTES = [
    ['#7c3aed', '#a78bfa'], ['#c2185b', '#f48fb1'], ['#0d9488', '#5eead4'],
    ['#d97706', '#fcd34d'], ['#0284c7', '#7dd3fc'], ['#dc2626', '#fca5a5'],
    ['#059669', '#6ee7b7'], ['#7c3aed', '#c4b5fd'], ['#db2777', '#f9a8d4'],
    ['#b45309', '#fde68a'],
];

function getAvatarColors(name) {
    const idx = Math.abs(name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % COLOR_PALETTES.length;
    return COLOR_PALETTES[idx];
}

function makeAvatar(name, size = 36) {
    const [c1, c2] = getAvatarColors(name);
    const initial = name.charAt(0).toUpperCase();
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,${c1},${c2});display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.4)}px;flex-shrink:0;">${initial}</div>`;
}

// ─── Screen Router ──────────────────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(`screen-${id}`);
    if (el) el.classList.add('active');
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), duration);
}

// ─── Log helper ─────────────────────────────────────────────────────────────
function addLog(msg, type = '') {
    const entries = document.getElementById('log-entries');
    if (!entries) return;
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const el = document.createElement('div');
    el.className = `log-entry ${type}`;
    el.innerHTML = `<span class="log-time">${now}</span>${msg}`;
    entries.prepend(el);
}

// ─── Lobby ───────────────────────────────────────────────────────────────────
function showTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`btn-tab-${tab}`).classList.add('active');
    document.getElementById(`panel-${tab}`).classList.add('active');
}

function setLobbyError(msg) {
    const el = document.getElementById('lobby-error');
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
}

function createGame() {
    const name = document.getElementById('input-host-name').value.trim();
    if (!name) { setLobbyError('Please enter your name.'); return; }
    setLobbyError('');
    state.myName = name;
    state.isHost = true;
    socket.emit('create-game', { playerName: name });
}

function joinGame() {
    const name = document.getElementById('input-join-name').value.trim();
    const code = document.getElementById('input-room-code').value.trim().toUpperCase();
    if (!name) { setLobbyError('Please enter your name.'); return; }
    if (!code || code.length < 4) { setLobbyError('Please enter a valid room code.'); return; }
    setLobbyError('');
    state.myName = name;
    state.isHost = false;
    socket.emit('join-game', { playerName: name, roomCode: code });
}

function copyRoomCode() {
    const code = state.roomCode;
    navigator.clipboard?.writeText(code).catch(() => { });
    showToast(`Room code "${code}" copied!`);
}

function copyShareLink() {
    const url = document.getElementById('share-url').textContent;
    navigator.clipboard?.writeText(url).catch(() => { });
    showToast('Share link copied!');
}

function adjustTimer(delta) {
    if (!state.isHost) return;
    const next = Math.min(5, Math.max(1, state.discussionMinutes + delta));
    socket.emit('set-timer', { minutes: next });
}

function adjustNightTimer(delta) {
    if (!state.isHost) return;
    const next = Math.min(120, Math.max(10, state.nightPhaseSeconds + delta));
    socket.emit('set-night-timer', { seconds: next });
}

function adjustVoteTimer(delta) {
    if (!state.isHost) return;
    const next = Math.min(60, Math.max(10, state.voteSeconds + delta));
    socket.emit('set-vote-timer', { seconds: next });
}

function updateTimerDisplay(minutes) {
    state.discussionMinutes = minutes;
    document.getElementById('timer-display').textContent = `${minutes} min`;
}

socket.on('night-timer-updated', ({ seconds }) => {
    state.nightPhaseSeconds = seconds;
    document.getElementById('night-timer-display').textContent = `${seconds} sec`;
});

socket.on('vote-timer-updated', ({ seconds }) => {
    state.voteSeconds = seconds;
    document.getElementById('vote-timer-display').textContent = `${seconds} sec`;
});

function startGame() {
    socket.emit('start-game');
}

// ─── Waiting Room ────────────────────────────────────────────────────────────
function renderPlayerList(players, hostName) {
    const list = document.getElementById('player-list');
    list.innerHTML = players.map(p => `
    <li class="player-item">
      ${makeAvatar(p.name)}
      <span class="player-item-name">${escHtml(p.name)}${p.name === state.myName ? ' <em style="color:var(--text3);font-size:0.75rem;">(you)</em>' : ''}</span>
      ${p.isHost ? '<span class="player-host-tag">Host</span>' : ''}
    </li>
  `).join('');

    const count = players.length;
    document.getElementById('player-count-badge').textContent = `${count}/10`;

    const startBtn = document.getElementById('btn-start-game');
    if (startBtn) {
        startBtn.disabled = count < 6;
    }
    document.getElementById('waiting-hint').textContent =
        count < 6 ? `${6 - count} more player${6 - count !== 1 ? 's' : ''} needed to start`
            : `${count} player${count !== 1 ? 's' : ''} ready!`;
}

// ─── Role Reveal ─────────────────────────────────────────────────────────────
function flipRoleCard() {
    const card = document.getElementById('role-card');
    card.classList.add('flipped');
    document.getElementById('btn-flip-card').classList.add('hidden');
    // Show the persistent role sidebar only after the player has seen their role
    document.getElementById('role-sidebar').classList.remove('hidden');
    document.body.classList.add('has-role');

    // Reveal Mafia allies only now (data was stored when mafia-reveal fired)
    if (state.mafiaAlliesHtml !== null) {
        const box = document.getElementById('mafia-reveal-box');
        box.classList.remove('hidden');
        document.getElementById('mafia-allies-list').innerHTML = state.mafiaAlliesHtml;

        const rsAllies = document.getElementById('rs-allies');
        rsAllies.classList.remove('hidden');
        document.getElementById('rs-allies-list').innerHTML = state.mafiaAlliesSidebarHtml;
    }

    setTimeout(() => {
        document.getElementById('btn-goto-game').classList.remove('hidden');
    }, 900);
}

function gotoGame() {
    // Notify server this player has viewed their role; show waiting panel
    document.getElementById('btn-goto-game').classList.add('hidden');
    document.getElementById('role-waiting-panel').classList.remove('hidden');
    socket.emit('role-ready');
}

// ─── Game Screen helpers ──────────────────────────────────────────────────────
function renderPlayersBoard(players) {
    state.players = players;
    const board = document.getElementById('players-board');
    board.innerHTML = players.map(p => {
        const isYou = p.name === state.myName;
        const isDead = !p.alive;
        return `
      <div class="player-token ${isDead ? 'dead' : ''} ${isYou ? 'you' : ''}" id="token-${p.id}">
        ${makeAvatar(p.name, 40)}
        <span class="p-token-name">${escHtml(p.name)}${isYou ? '\n(you)' : ''}</span>
        <span class="p-token-status">${isDead ? '💀 Eliminated' : '✦ Alive'}</span>
      </div>
    `;
    }).join('');
}

function updatePhaseBanner(icon, name, sub, timer = '') {
    document.getElementById('phase-icon').textContent = icon;
    document.getElementById('phase-name').textContent = name;
    document.getElementById('phase-sub').textContent = sub;
    document.getElementById('phase-timer').textContent = timer;
}

function hideAllPanels() {
    ['night-action-panel', 'night-wait-panel', 'night-timer-ring',
        'day-discuss-panel', 'voting-panel', 'investigation-popup',
        'night-outcome-splash', 'ghost-guess-panel',
        'day-outcome-splash'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
}

// ─── Night Timer Ring ─────────────────────────────────────────────────────────
let nightRingInterval = null;

function startNightRing(seconds) {
    clearInterval(nightRingInterval);
    const ring = document.getElementById('ring-fill');
    const count = document.getElementById('ring-count');
    const circumference = 276.46;
    let remaining = seconds;

    function update() {
        const pct = remaining / seconds;
        ring.style.strokeDashoffset = circumference * (1 - pct);
        count.textContent = remaining;
        if (remaining <= 0) { clearInterval(nightRingInterval); return; }
        remaining--;
    }
    update();
    nightRingInterval = setInterval(update, 1000);
    document.getElementById('night-timer-ring').classList.remove('hidden');
}

// ─── Voting Ring ──────────────────────────────────────────────────────────────
let voteRingInterval = null;

function startVoteRing(seconds) {
    clearInterval(voteRingInterval);
    const ring = document.getElementById('vote-ring-fill');
    const count = document.getElementById('vote-ring-count');
    const circumference = 276.46;
    let remaining = seconds;

    function update() {
        const pct = remaining / seconds;
        ring.style.strokeDashoffset = circumference * (1 - pct);
        count.textContent = remaining;
        if (remaining <= 0) { clearInterval(voteRingInterval); return; }
        remaining--;
    }
    update();
    voteRingInterval = setInterval(update, 1000);
}

// ─── Discussion Timer ─────────────────────────────────────────────────────────
let discussInterval = null;

function startDiscussTimer(seconds) {
    clearInterval(discussInterval);
    document.getElementById('discuss-timer-fill').style.width = '100%';
    let remaining = seconds;

    function format(s) {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    }

    function update() {
        const pct = (remaining / seconds) * 100;
        document.getElementById('discuss-timer-fill').style.width = `${pct}%`;
        document.getElementById('discuss-countdown').textContent = format(remaining);
        if (remaining <= 0) { clearInterval(discussInterval); return; }
        remaining--;
    }
    update();
    discussInterval = setInterval(update, 1000);
}

// ─── Night Action Panel ───────────────────────────────────────────────────────
function showNightActionPanel(role, targets, timeLeft = 30) {
    hideAllPanels();
    const panel = document.getElementById('night-action-panel');
    panel.classList.remove('hidden');

    // Reset any leftover investigation result from a previous turn
    document.getElementById('invest-inline').classList.add('hidden');
    document.getElementById('targets-grid').classList.remove('hidden');

    // Store all targets (including self if server sent it)
    state.allTargets = targets;

    // Title & description per role
    const titles = {
        MAFIA_GROUP: '⚔️ Choose a target to eliminate',
        DOCTOR: '💉 Choose a player to protect tonight',
        POLICE: '🔍 Choose a player to investigate',
        JOKER: '🃏 Choose your action and target',
        VIGILANTE: '🔫 Choose your target',
    };
    document.getElementById('action-title').textContent = titles[role] || 'Choose a target';
    document.getElementById('action-desc').textContent =
        role === 'MAFIA_GROUP' ? 'Discuss in your mafia chat and vote for the same player.' : '';

    // Joker sub-actions
    const jokerDiv = document.getElementById('joker-actions');
    if (role === 'JOKER') {
        jokerDiv.classList.remove('hidden');
        state.jokerAction = 'kill';
        selectJokerAction('kill'); // this renders the grid
    } else {
        jokerDiv.classList.add('hidden');
        renderTargetGrid(targets); // Doctor/Police/Vigilante: use full list as-is
    }

    state.selectedTarget = null;
    document.getElementById('action-confirm').classList.add('hidden');
    // Show skip button only for Vigilante
    const skipBtn = document.getElementById('vig-skip-btn');
    if (skipBtn) skipBtn.classList.toggle('hidden', role !== 'VIGILANTE');
    startNightRing(timeLeft);
}

function selectTarget(id, name) {
    state.selectedTarget = id;
    document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById(`target-${id}`)?.classList.add('selected');
    document.getElementById('confirm-target-name').textContent = name;
    document.getElementById('action-confirm').classList.remove('hidden');
}

function cancelAction() {
    state.selectedTarget = null;
    document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('action-confirm').classList.add('hidden');
}

function skipVigilanteAction() {
    clearInterval(nightRingInterval);
    socket.emit('skip-vigilante-action');
    hideAllPanels();
    showNightWaitPanel('You held your shot. Waiting for others...');
}

// Renders target buttons from a list, self entries get a "(You)" label
function renderTargetGrid(targets) {
    const grid = document.getElementById('targets-grid');
    grid.innerHTML = targets.map(t => `
    <button class="target-btn" id="target-${t.id}" onclick="selectTarget('${t.id}', '${escHtml(t.isSelf ? t.name + ' (You)' : t.name)}')">
      ${makeAvatar(t.name, 30)}
      <span class="target-name">${escHtml(t.name)}${t.isSelf ? ' <em style="color:var(--text3);font-size:0.75rem;">(You)</em>' : ''}</span>
    </button>
  `).join('');
    // Clear any prior selection when grid re-renders
    state.selectedTarget = null;
    document.getElementById('action-confirm').classList.add('hidden');
}

function selectJokerAction(action) {
    state.jokerAction = action;
    ['kill', 'protect', 'investigate'].forEach(a => {
        document.getElementById(`jbtn-${a}`)?.classList.toggle('active', a === action);
    });
    // Re-render targets: include self only for protect
    const targets = action === 'protect'
        ? state.allTargets
        : state.allTargets.filter(t => !t.isSelf);
    renderTargetGrid(targets);
}

function confirmAction() {
    const targetId = state.selectedTarget;
    if (!targetId) return;

    const roleKey = state.currentNightRole;
    const isInvestigation = roleKey === 'POLICE'
        || (roleKey === 'JOKER' && state.jokerAction === 'investigate');

    if (roleKey === 'MAFIA_GROUP') {
        socket.emit('mafia-vote', { targetId });
    } else if (roleKey === 'DOCTOR') {
        socket.emit('doctor-action', { targetId });
    } else if (roleKey === 'POLICE') {
        socket.emit('police-action', { targetId });
    } else if (roleKey === 'JOKER') {
        socket.emit('joker-action', { action: state.jokerAction, targetId });
    } else if (roleKey === 'VIGILANTE') {
        socket.emit('vigilante-action', { targetId });
    }

    addLog('You submitted your night action.', 'safe-ev');

    if (isInvestigation) {
        // Keep the action panel open — the investigation-result event will show the inline result.
        // Timer ring keeps running until server advances the turn naturally.
        document.getElementById('action-confirm').classList.add('hidden');
        return;
    }

    // All other roles: transition to wait panel immediately
    clearInterval(nightRingInterval);
    hideAllPanels();
    showNightWaitPanel('Your action has been submitted. Waiting for others...');
}

function showNightWaitPanel(text) {
    hideAllPanels();
    document.getElementById('night-wait-panel').classList.remove('hidden');
    document.getElementById('night-wait-text').textContent = text;
    // Keep passive ghost section state — it's re-shown by ghost-passive-turn each night
}

// ─── Voting ───────────────────────────────────────────────────────────────────
function renderVoteGrid(players) {
    const grid = document.getElementById('vote-grid');
    const alive = players.filter(p => p.name !== state.myName);
    grid.innerHTML = alive.map(p => `
    <button class="vote-btn" id="vote-btn-${p.id}" onclick="castVote('${p.id}')">
      ${makeAvatar(p.name, 32)}
      <span class="vote-name">${escHtml(p.name)}</span>
    </button>
  `).join('');
}

function castVote(targetId) {
    if (state.hasVoted || !state.isAlive) return;
    state.hasVoted = true;

    socket.emit('cast-vote', { targetId });

    if (targetId) {
        document.querySelectorAll('.vote-btn').forEach(b => {
            b.disabled = true;
            b.classList.remove('voted');
        });
        document.getElementById(`vote-btn-${targetId}`)?.classList.add('voted');
        addLog('You cast your vote.', 'safe-ev');
    } else {
        document.querySelectorAll('.vote-btn').forEach(b => b.disabled = true);
        addLog('You abstained from voting.');
    }
    document.getElementById('btn-abstain').disabled = true;
}

// ─── Investigation popup ──────────────────────────────────────────────────────
function showInvestResult(targetName, group, role) {
    const popup = document.getElementById('investigation-popup');
    popup.classList.remove('hidden');
    const groupColor = group === 'mafia' ? '#fca5a5' : group === 'civilian' ? '#86efac' : '#fcd34d';
    document.getElementById('invest-icon').textContent = group === 'mafia' ? '🩸' : group === 'civilian' ? '✅' : '⭐';
    document.getElementById('invest-result').innerHTML =
        `<strong style="color:${groupColor}">${escHtml(targetName)}</strong> is a member of the <strong style="color:${groupColor}">${capitalize(group)} Group</strong>.<br><span style="color:var(--text3);font-size:0.82rem;">Role: ${escHtml(role)}</span>`;
}

function closeInvestigation() {
    document.getElementById('investigation-popup').classList.add('hidden');
}

function doneInvestigation() {
    socket.emit('investigation-done');
    clearInterval(nightRingInterval);
    hideAllPanels();
    showNightWaitPanel('Your action has been submitted. Waiting for others...');
}

// ── Ghost Guess (eliminated players only) ─────────────────────────────────

function showGhostGuessPanel(alivePlayers) {
    hideAllPanels();
    const panel = document.getElementById('ghost-guess-panel');
    panel.classList.remove('hidden');
    document.getElementById('gg-confirmed').classList.add('hidden');
    document.getElementById('gg-none-btn').disabled = false;

    const grid = document.getElementById('gg-grid');
    grid.innerHTML = alivePlayers.map(p => `
        <button class="gg-btn" id="gg-btn-${p.id}"
            onclick="submitGhostGuess('${p.id}')">
            ${makeAvatar(p.name, 26)}
            <span>${escHtml(p.name)}</span>
        </button>
    `).join('');
}

function submitGhostGuess(targetId) {
    socket.emit('ghost-guess', { targetId });
    document.querySelectorAll('.gg-btn').forEach(b => b.classList.remove('selected'));
    if (targetId !== 'none') {
        document.getElementById(`gg-btn-${targetId}`)?.classList.add('selected');
    } else {
        document.getElementById('gg-none-btn')?.classList.add('selected');
    }
}

// Passive ghost guess (Civilian/Jester dead players — persistent, no timer)
function submitPassiveGuess(targetId) {
    socket.emit('ghost-guess', { targetId });
    // Highlight selection
    document.querySelectorAll('.gp-btn').forEach(b => b.classList.remove('selected'));
    if (targetId !== 'none') {
        document.getElementById(`gp-btn-${targetId}`)?.classList.add('selected');
    } else {
        document.getElementById('gp-none-btn')?.classList.add('selected');
    }
    // Lock all passive buttons after guess
    document.querySelectorAll('.gp-btn, #gp-none-btn').forEach(b => b.disabled = true);
    document.getElementById('gp-confirmed').classList.remove('hidden');
}

// ─── Mafia Chat ───────────────────────────────────────────────────────────────
function sendMafiaChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    socket.emit('mafia-chat', { message: msg });
    input.value = '';
}

function chatKeyDown(e) {
    if (e.key === 'Enter') sendMafiaChat();
}

function appendChatMessage(sender, message, time) {
    const container = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="chat-sender">${escHtml(sender)}</span><span class="chat-time">${time}</span><div class="chat-text">${escHtml(message)}</div>`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO Event Handlers
// ─────────────────────────────────────────────────────────────────────────────

socket.on('error', ({ message }) => {
    setLobbyError(message);
    showToast(message, 4000);
});

// ── Lobby / Waiting Room ──────────────────────────────────────────────────────
socket.on('game-created', ({ code, playerName }) => {
    state.roomCode = code;
    document.getElementById('display-room-code').textContent = code;
    showScreen('waiting');

    // Show share bar
    const shareBar = document.getElementById('share-link-bar');
    const shareUrl = `${window.location.origin}?code=${code}`;
    document.getElementById('share-url').textContent = shareUrl;
    shareBar.classList.remove('hidden');

    // Show host controls
    document.getElementById('host-controls').style.display = 'block';
});

socket.on('game-joined', ({ code, playerName }) => {
    state.roomCode = code;
    document.getElementById('display-room-code').textContent = code;
    showScreen('waiting');
    document.getElementById('host-controls').style.display = 'none';
});

socket.on('lobby-update', ({ players, hostName }) => {
    renderPlayerList(players, hostName);
    const me = players.find(p => p.name === state.myName);
    if (me) state.isHost = me.isHost;
    if (state.isHost) {
        document.getElementById('host-controls').style.display = 'block';
    }
});

socket.on('host-changed', ({ newHost }) => {
    if (newHost === state.myName) {
        state.isHost = true;
        document.getElementById('host-controls').style.display = 'block';
        showToast('You are now the host!');
    }
});

socket.on('timer-updated', ({ minutes }) => {
    updateTimerDisplay(minutes);
});

socket.on('role-ready-update', ({ readyPlayers, waitingPlayers }) => {
    document.getElementById('ready-players-list').innerHTML =
        readyPlayers.map(n => `<div class="ready-chip">${escHtml(n)}</div>`).join('');
    document.getElementById('waiting-players-list').innerHTML =
        waitingPlayers.map(n => `<div class="waiting-chip">${escHtml(n)}</div>`).join('');
});

// ── Game Start & Role Reveal ─────────────────────────────────────────────────
socket.on('game-started', ({ players }) => {
    renderPlayersBoard(players.map(p => ({ ...p, alive: true })));
    addLog('The game has begun!', 'important');
});

socket.on('role-assigned', ({ role, roleKey, group, description }) => {
    state.myRole = role;
    state.myRoleKey = roleKey;
    state.myGroup = group;
    state.isMafia = group === 'mafia';

    // ── Role reveal card (flip screen) ──
    document.getElementById('role-icon').textContent = ROLE_ICONS[roleKey] || '❓';
    document.getElementById('role-name').textContent = role;
    document.getElementById('role-desc').textContent = description;

    const badge = document.getElementById('role-group-badge');
    badge.textContent = capitalize(group);
    badge.className = `role-group-badge ${group}`;

    if (group === 'mafia') {
        document.getElementById('mafia-chat-sidebar').classList.remove('hidden');
    }

    // ── Persistent role sidebar (data only — stays hidden until card is flipped) ──
    const sidebar = document.getElementById('role-sidebar');
    sidebar.classList.add(group); // adds colour class WITHOUT removing 'hidden'
    document.getElementById('rs-icon').textContent = ROLE_ICONS[roleKey] || '❓';
    document.getElementById('rs-name').textContent = role;
    document.getElementById('rs-badge').textContent = capitalize(group);
    document.getElementById('rs-desc').textContent = description;
    // Sidebar becomes visible in flipRoleCard()

    showScreen('role-reveal');
});

socket.on('mafia-reveal', ({ mafiaNames }) => {
    const allies = mafiaNames.filter(n => n !== state.myName);

    // Store HTML to render — both boxes shown only after card is flipped
    state.mafiaAlliesHtml = allies.length > 0
        ? allies.map(n => `<div class="ally-chip">${escHtml(n)}</div>`).join('')
        : '<span style="color:var(--text3);font-size:0.85rem;">You are the only Mafia member.</span>';

    state.mafiaAlliesSidebarHtml = allies.length > 0
        ? allies.map(n => `<div class="rs-ally-chip">${escHtml(n)}</div>`).join('')
        : '<span style="color:var(--text3);font-size:0.76rem;">Solo Mafia</span>';
});

// ── Night Phase ───────────────────────────────────────────────────────────────
socket.on('night-phase-start', ({ round }) => {
    showScreen('game'); // transition from role reveal to game
    hideAllPanels();
    updatePhaseBanner('🌙', 'Night Phase', `Round ${round}`);
    addLog(`Round ${round} — Night has fallen.`, 'important');
    showNightWaitPanel('The village sleeps...');
});

socket.on('ghost-night-turn', ({ alivePlayers, timeLeft }) => {
    showGhostGuessPanel(alivePlayers);
    startNightRing(timeLeft || 30);
    addLog('👻 As a ghost, predict who the Mafia will eliminate tonight!', 'safe-ev');
});

socket.on('ghost-passive-turn', ({ alivePlayers }) => {
    // Show the persistent guess section below the wait panel for non-ability dead players
    const section = document.getElementById('ghost-passive-section');
    section.classList.remove('hidden');
    document.getElementById('gp-confirmed').classList.add('hidden');
    // Re-enable all buttons (fresh night)
    document.querySelectorAll('.gp-btn, #gp-none-btn').forEach(b => b.disabled = false);
    document.querySelector('#gp-none-btn')?.classList.remove('selected');
    const grid = document.getElementById('gp-grid');
    grid.innerHTML = alivePlayers.map(p => `
        <button class="gp-btn" id="gp-btn-${p.id}" onclick="submitPassiveGuess('${p.id}')">
            ${makeAvatar(p.name, 22)}
            <span>${escHtml(p.name)}</span>
        </button>
    `).join('');
});

socket.on('ghost-guess-ack', () => {
    // Timed ghost panel confirmation
    document.getElementById('gg-confirmed').classList.remove('hidden');
});

socket.on('night-turn', ({ role, actorNames, timeLeft }) => {
    const roleLabel = role === 'MAFIA_GROUP' ? 'Mafia' : role;
    document.getElementById('night-turn-status').textContent = `${roleLabel} is deciding...`;
    // Non-actors see the wait panel
});

socket.on('your-night-turn', ({ role, targets, timeLeft }) => {
    state.currentNightRole = role;
    state.isAlive = true;
    showNightActionPanel(role, targets, timeLeft);
    addLog(`It's your turn to act as ${role === 'MAFIA_GROUP' ? 'Mafia' : role}.`, 'safe-ev');
});

socket.on('night-turn-done', ({ role }) => {
    hideAllPanels();
    showNightWaitPanel('Waiting for the night to pass...');
});

socket.on('night-turn-skipped', ({ role }) => {
    addLog(`${role === 'MAFIA_GROUP' ? 'Mafia' : role} skipped their action.`);
    clearInterval(nightRingInterval);
    hideAllPanels();
    showNightWaitPanel('Waiting for the night to pass...');
});

socket.on('night-resolved', ({ eliminated, events, correctGuessers }) => {
    events.forEach(ev => addLog(ev.message, ev.type === 'save' ? 'safe-ev' : ''));

    // Update player board
    if (eliminated.length > 0) {
        eliminated.forEach(name => {
            addLog(`☠️ ${name} was eliminated during the night.`, 'important');
            if (name === state.myName) state.isAlive = false;
        });
        state.players = state.players.map(p => ({
            ...p,
            alive: eliminated.includes(p.name) ? false : p.alive,
        }));
        renderPlayersBoard(state.players);
    } else {
        addLog('Nobody was eliminated overnight. The village breathes a sigh of relief.', 'safe-ev');
    }

    // Show night outcome splash
    hideAllPanels();
    const splash = document.getElementById('night-outcome-splash');
    splash.classList.remove('hidden');

    if (eliminated.length > 0) {
        document.getElementById('nos-dawn-icon').textContent = '☠️';
        document.getElementById('nos-title').textContent = 'Night Falls Silent…';
        document.getElementById('nos-results').innerHTML = eliminated
            .map(name => `<div class="nos-card eliminated"><span>☠️ <strong>${escHtml(name.trim())}</strong> was found dead at dawn.</span></div>`)
            .join('');
    } else {
        document.getElementById('nos-dawn-icon').textContent = '🌅';
        document.getElementById('nos-title').textContent = 'Dawn Breaks…';
        document.getElementById('nos-results').innerHTML =
            `<div class="nos-card safe">💚 No one was killed tonight. The village is safe… for now.</div>`;
    }

    // Ghost Activity Detected section
    const ghostSection = document.getElementById('nos-ghost-section');
    if (correctGuessers && correctGuessers.length > 0) {
        ghostSection.classList.remove('hidden');
        document.getElementById('nos-ghost-names').innerHTML =
            correctGuessers.map(n => `<span class="nos-ghost-chip">👻 ${escHtml(n)} made a haunted prediction!</span>`).join('');
    } else {
        ghostSection.classList.add('hidden');
    }
});

// ── Day Phase ─────────────────────────────────────────────────────────────────
socket.on('day-phase-start', ({ players, discussionSeconds }) => {
    hideAllPanels();
    updatePhaseBanner('☀️', 'Day Phase', 'Discussion');

    // Use state.players as source of truth (already updated with night eliminations).
    // The server only sends alive players; use that to confirm alive status but keep dead players visible.
    const aliveIds = new Set(players.map(p => p.id));
    state.players = state.players.map(p => ({ ...p, alive: aliveIds.has(p.id) }));
    renderPlayersBoard(state.players);

    const panel = document.getElementById('day-discuss-panel');
    panel.classList.remove('hidden');
    document.getElementById('day-announcements').innerHTML = '';

    startDiscussTimer(discussionSeconds);
    addLog('Day phase — discuss and identify the Mafia!', 'important');
});

socket.on('voting-start', ({ players, timeLeft }) => {
    hideAllPanels();
    updatePhaseBanner('🗳️', 'Voting Phase', '');
    state.hasVoted = false;

    const panel = document.getElementById('voting-panel');
    panel.classList.remove('hidden');

    renderVoteGrid(players);
    document.getElementById('vote-status').textContent = `0 / ${players.length} voted`;
    // Reset feed for this round
    document.getElementById('vote-feed').innerHTML = '';
    document.getElementById('vote-feed-wrap').classList.add('hidden');

    const abstainBtn = document.getElementById('btn-abstain');
    if (!state.isAlive) {
        // Eliminated players cannot vote
        document.querySelectorAll('.vote-btn').forEach(b => b.disabled = true);
        abstainBtn.disabled = true;
        addLog('You have been eliminated and cannot vote.', 'important');
    } else {
        abstainBtn.disabled = false;
    }

    startVoteRing(timeLeft);
    addLog('Voting has started! You have 30 seconds to cast your vote.', 'important');
});

socket.on('vote-cast', ({ voterName, targetName, votedCount, totalCount }) => {
    // Update count
    document.getElementById('vote-status').textContent = `${votedCount} / ${totalCount} voted`;
    // Show feed section on first vote
    document.getElementById('vote-feed-wrap').classList.remove('hidden');
    // Append animated entry
    const feed = document.getElementById('vote-feed');
    const item = document.createElement('div');
    item.className = 'vote-feed-item';
    const targetClass = targetName ? 'vs-player' : 'vs-abstain';
    const targetText = targetName ? escHtml(targetName) : 'abstained';
    item.innerHTML = `<span class="vfi-voter">${escHtml(voterName)}</span>
        <span class="vfi-arrow">→</span>
        <span class="vfi-target ${targetClass}">${targetText}</span>`;
    feed.appendChild(item);
    feed.scrollTop = feed.scrollHeight;
});

socket.on('vote-resolved', ({ eliminated, tie, votes, voteDetails, noVoteNames, jesterWin }) => {
    hideAllPanels();
    clearInterval(voteRingInterval);

    // Update player state
    if (eliminated) {
        if (eliminated === state.myName) state.isAlive = false;
        state.players = state.players.map(p => ({
            ...p, alive: p.name === eliminated ? false : p.alive,
        }));
        renderPlayersBoard(state.players);
        addLog(`☠️ ${eliminated} was voted out${jesterWin ? ' — THE JESTER WINS!' : '!'}`, 'important');
    } else if (tie) {
        addLog('🤝 The vote was tied or lacked majority — no one was eliminated.', 'safe-ev');
    } else {
        addLog('No one was voted out this round.', 'safe-ev');
    }

    // ── Build day outcome splash ──
    const splash = document.getElementById('day-outcome-splash');
    splash.classList.remove('hidden');

    if (eliminated) {
        document.getElementById('dos-icon').textContent = '⚀️';
        document.getElementById('dos-title').textContent = 'The Village Has Spoken';
        document.getElementById('dos-result').innerHTML =
            `<div class="dos-result-card eliminated"><span>☠️ <strong>${escHtml(eliminated)}</strong> was voted out by the village${jesterWin ? ' — 🂣 THE JESTER WINS!' : ''}.</span></div>`;
    } else {
        document.getElementById('dos-icon').textContent = '🌍';
        document.getElementById('dos-title').textContent = 'Everyone Survives the Day!';
        document.getElementById('dos-result').innerHTML =
            `<div class="dos-result-card safe"><span>💚 No one was eliminated. The village lives to see another night.</span></div>`;
    }

    // Vote breakdown
    const bd = document.getElementById('dos-breakdown');
    const rows = [];
    (voteDetails || []).forEach(({ voterName, targetName }) => {
        const cls = targetName ? 't-voted' : 't-abstain';
        const txt = targetName ? `voted against <strong>${escHtml(targetName)}</strong>` : 'abstained';
        rows.push(`<div class="dos-row"><span class="dr-voter">${escHtml(voterName)}</span><span class="dr-arrow">→</span><span class="dr-target ${cls}">${txt}</span></div>`);
    });
    (noVoteNames || []).forEach(name => {
        rows.push(`<div class="dos-row"><span class="dr-voter">${escHtml(name)}</span><span class="dr-arrow">→</span><span class="dr-target t-novote">didn't vote</span></div>`);
    });
    bd.innerHTML = rows.join('');
});

// ── Player eliminated mid-game ────────────────────────────────────────────────
socket.on('player-disconnected', ({ name }) => {
    addLog(`⚠️ ${name} disconnected and was eliminated.`, 'important');
    // Update their token
    const players = state.players.map(p => p.name === name ? { ...p, alive: false } : p);
    renderPlayersBoard(players);
});

socket.on('investigation-result', ({ targetName, group, role }) => {
    // Hide the selection UI
    document.getElementById('targets-grid').classList.add('hidden');
    document.getElementById('action-confirm').classList.add('hidden');
    document.getElementById('joker-actions').classList.add('hidden');

    // Build inline result inside the action panel
    const groupColor = group === 'mafia' ? '#fca5a5' : group === 'civilian' ? '#86efac' : '#fcd34d';
    const icon = group === 'mafia' ? '🩸' : group === 'civilian' ? '✅' : '⭐';

    document.getElementById('invest-inline-icon').textContent = icon;
    document.getElementById('invest-inline-result').innerHTML =
        `<strong style="color:${groupColor}">${escHtml(targetName)}</strong> belongs to the `
        + `<strong style="color:${groupColor}">${capitalize(group)} Group</strong>`
        + `<br><span style="color:var(--text3);font-size:0.82rem;">Role: ${escHtml(role)}</span>`;

    document.getElementById('invest-inline').classList.remove('hidden');
    addLog('Your investigation is complete.', 'safe-ev');
});

socket.on('mafia-vote-update', ({ votes, currentTarget, allVoted }) => {
    const targetPlayer = state.players.find(p => p.id === currentTarget);
    if (targetPlayer) {
        document.getElementById('action-desc').textContent =
            `Current consensus: ${targetPlayer.name}${allVoted ? ' (all voted!)' : ''}`;
    }
});

socket.on('mafia-chat-message', ({ sender, message, timestamp }) => {
    appendChatMessage(sender, message, timestamp);
});

// ── Game Over ─────────────────────────────────────────────────────────────────
socket.on('game-over', ({ winner, reason, roleReveal }) => {
    clearInterval(nightRingInterval);
    clearInterval(voteRingInterval);
    clearInterval(discussInterval);

    const winEmojis = { Mafia: '🔪', Civilians: '☀️', Neutrals: '⭐', Jester: '🃏', null: '💥' };
    document.getElementById('winner-badge').textContent = winEmojis[winner] || '🎭';
    document.getElementById('winner-name').textContent = winner ? `${winner} Win${winner === 'Jester' ? 's' : ''}!` : 'No Winner!';
    document.getElementById('winner-reason').textContent = reason;

    // Role reveal grid
    const grid = document.getElementById('role-reveal-grid');
    grid.innerHTML = roleReveal.map(p => `
    <div class="reveal-chip ${p.alive ? '' : 'dead'}">
      <div class="role-dot ${p.group}"></div>
      ${makeAvatar(p.name, 28)}
      <div>
        <div class="reveal-chip-name">${escHtml(p.name)}${!p.alive ? ' ☠️' : ''}</div>
        <div class="reveal-chip-role">${escHtml(p.role)}</div>
      </div>
    </div>
  `).join('');

    showScreen('results');
    addLog(`Game over — ${winner || 'No one'} wins!`, 'important');
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-fill room code from URL if present (?code=XXXXX)
// ─────────────────────────────────────────────────────────────────────────────
(function autoFillCode() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
        showTab('join');
        document.getElementById('input-room-code').value = code.toUpperCase();
    }
})();
