const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════════════════════════
//                    CONFIG
// ═══════════════════════════════════════════════════════════════

const API_KEY = "SALAH2026";
const PROXY_URL = "https://roblox-proxy.salahelarabi03.workers.dev";

const PLACES = {
    REBIRTH_0: "96342491571673",
    REBIRTH_1_PLUS: "109983668079237"
};

const SCAN_INTERVAL = 15000;
const MAX_PAGES = 10;
const MIN_PLAYERS = 6;
const MAX_PLAYERS = 7;

const JOBID_LOCK_TTL = 90 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const POOL_TTL = 3 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════
//                    STATE
// ═══════════════════════════════════════════════════════════════

const pools = {
    [PLACES.REBIRTH_0]: new Map(),
    [PLACES.REBIRTH_1_PLUS]: new Map()
};

const jobLocks = new Map();
const botHistory = new Map();

// ✅ NOUVEAU: Stockage des rapports
const reports = new Map(); // botName -> { lastReport, brainrots, etc }
const recentBrainrots = []; // Top brainrots récents

const stats = {
    startedAt: Date.now(),
    totalRequests: 0,
    successfulAssignments: 0,
    rejectedNoServers: 0,
    rejectedAllVisited: 0,
    rejectedAllLocked: 0,
    scansCompleted: 0,
    scansFailed: 0,
    reportsReceived: 0
};

// ═══════════════════════════════════════════════════════════════
//                    SCANNER ROBLOX
// ═══════════════════════════════════════════════════════════════

async function fetchServersPage(placeId, cursor = "") {
    const url = `${PROXY_URL}/v1/games/${placeId}/servers/Public?sortOrder=Desc&excludeFullGames=true&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            console.error(`[SCAN] HTTP ${response.status} for ${placeId}`);
            return null;
        }
        
        return await response.json();
    } catch (err) {
        console.error(`[SCAN] Fetch error:`, err.message);
        return null;
    }
}

async function scanPlace(placeId) {
    const pool = pools[placeId];
    let totalServers = 0;
    let cursor = "";
    let pages = 0;
    
    while (pages < MAX_PAGES) {
        const data = await fetchServersPage(placeId, cursor);
        
        if (!data || !data.data) {
            stats.scansFailed++;
            break;
        }
        
        for (const server of data.data) {
            const playing = server.playing || 0;
            const maxPlayers = server.maxPlayers || 8;
            
            if (playing >= MIN_PLAYERS && playing <= MAX_PLAYERS) {
                pool.set(server.id, {
                    players: playing,
                    maxPlayers: maxPlayers,
                    addedAt: Date.now()
                });
                totalServers++;
            }
        }
        
        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
        pages++;
    }
    
    const now = Date.now();
    for (const [jobId, info] of pool.entries()) {
        if (now - info.addedAt > POOL_TTL) {
            pool.delete(jobId);
        }
    }
    
    stats.scansCompleted++;
    console.log(`[SCAN] ${placeId.slice(0, 8)}... → ${totalServers} serveurs (pool: ${pool.size}, pages: ${pages})`);
}

async function scannerLoop() {
    while (true) {
        try {
            await Promise.all([
                scanPlace(PLACES.REBIRTH_0),
                scanPlace(PLACES.REBIRTH_1_PLUS)
            ]);
        } catch (err) {
            console.error(`[SCAN] Loop error:`, err.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
    }
}

// ═══════════════════════════════════════════════════════════════
//                    CLEANUP
// ═══════════════════════════════════════════════════════════════

function cleanupExpiredLocks() {
    const now = Date.now();
    let cleaned = 0;
    for (const [jobId, lock] of jobLocks.entries()) {
        if (now - lock.lockedAt > JOBID_LOCK_TTL) {
            jobLocks.delete(jobId);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[CLEANUP] ${cleaned} locks expirés`);
}

function cleanupExpiredHistory() {
    const now = Date.now();
    let totalCleaned = 0;
    for (const [botName, history] of botHistory.entries()) {
        for (const [jobId, visitedAt] of history.entries()) {
            if (now - visitedAt > BOT_HISTORY_TTL) {
                history.delete(jobId);
                totalCleaned++;
            }
        }
        if (history.size === 0) botHistory.delete(botName);
    }
    if (totalCleaned > 0) console.log(`[CLEANUP] ${totalCleaned} entrées d'historique expirées`);
}

setInterval(() => {
    cleanupExpiredLocks();
    cleanupExpiredHistory();
}, 30000);

// ═══════════════════════════════════════════════════════════════
//                    SMART DISTRIBUTION
// ═══════════════════════════════════════════════════════════════

function getJobIdForBot(placeId, botName) {
    const pool = pools[placeId];
    
    if (!pool || pool.size === 0) {
        stats.rejectedNoServers++;
        return { error: 'NO_SERVERS', message: 'Pool vide' };
    }
    
    let history = botHistory.get(botName);
    if (!history) {
        history = new Map();
        botHistory.set(botName, history);
    }
    
    const availableJobs = [];
    
    for (const [jobId, info] of pool.entries()) {
        const lock = jobLocks.get(jobId);
        if (lock && lock.botName !== botName) continue;
        if (history.has(jobId)) continue;
        availableJobs.push({ jobId, info });
    }
    
    if (availableJobs.length === 0) {
        let allLocked = true;
        let allVisited = true;
        for (const [jobId] of pool.entries()) {
            const lock = jobLocks.get(jobId);
            if (!lock || lock.botName === botName) allLocked = false;
            if (!history.has(jobId)) allVisited = false;
        }
        if (allVisited) {
            stats.rejectedAllVisited++;
            return { error: 'ALL_VISITED', message: 'Tous les serveurs déjà visités par ce bot' };
        }
        if (allLocked) {
            stats.rejectedAllLocked++;
            return { error: 'ALL_LOCKED', message: 'Tous les serveurs sont lockés' };
        }
        return { error: 'NO_AVAILABLE', message: 'Aucun serveur disponible' };
    }
    
    const selected = availableJobs[Math.floor(Math.random() * availableJobs.length)];
    
    jobLocks.set(selected.jobId, {
        botName: botName,
        lockedAt: Date.now()
    });
    
    history.set(selected.jobId, Date.now());
    
    stats.successfulAssignments++;
    
    console.log(`[ASSIGN] ${botName} → ${selected.jobId.slice(0, 12)}... (${selected.info.players}/${selected.info.maxPlayers})`);
    
    return {
        jobId: selected.jobId,
        players: selected.info.players,
        maxPlayers: selected.info.maxPlayers
    };
}

// ═══════════════════════════════════════════════════════════════
//                    ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/jobs', (req, res) => {
    stats.totalRequests++;
    
    const { placeId, key } = req.query;
    const botName = req.headers.username || 'anonymous';
    
    if (key !== API_KEY) return res.status(401).send('Unauthorized');
    if (!placeId || !pools[placeId]) return res.status(400).send('Invalid placeId');
    
    const result = getJobIdForBot(placeId, botName);
    
    if (result.error) return res.status(503).send(result.message);
    
    res.type('text/plain').send(result.jobId);
});

// ✅ NOUVEAU: REPORT DATA - Recevoir les rapports des bots
app.post('/report-data', (req, res) => {
    const { key } = req.query;
    if (key !== API_KEY) return res.status(401).json({ error: 'Invalid key' });
    
    const data = req.body;
    if (!data || !data.botName) return res.status(400).json({ error: 'Missing botName' });
    
    stats.reportsReceived++;
    
    // Stocker le rapport du bot
    reports.set(data.botName, {
        ...data,
        receivedAt: Date.now()
    });
    
    // Si brainrot >= 40M, ajouter au top
    if (data.numeric && data.numeric >= 40000000) {
        recentBrainrots.unshift({
            botName: data.botName,
            jobId: data.jobId,
            name: data.name,
            money: data.money,
            numeric: data.numeric,
            mutation: data.mutation,
            source: data.source,
            timestamp: Date.now()
        });
        
        if (recentBrainrots.length > 50) {
            recentBrainrots.pop();
        }
    }
    
    console.log(`[REPORT] ${data.botName} → ${data.name || 'no brainrot'} (${data.money || ''})`);
    res.json({ success: true });
});

app.post('/report-failed', (req, res) => {
    const { jobId, key } = req.body;
    const botName = req.headers.username || 'anonymous';
    
    if (key !== API_KEY) return res.status(401).send('Unauthorized');
    if (!jobId) return res.status(400).send('Missing jobId');
    
    for (const placeId of Object.keys(pools)) {
        pools[placeId].delete(jobId);
    }
    jobLocks.delete(jobId);
    
    console.log(`[FAILED] ${botName} signale échec sur ${jobId.slice(0, 12)}...`);
    res.send('OK');
});

app.get('/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMins = Math.floor((uptime % 3600) / 60);
    
    res.json({
        uptime: `${uptimeHours}h ${uptimeMins}m`,
        pools: {
            rebirth0: pools[PLACES.REBIRTH_0].size,
            rebirth1plus: pools[PLACES.REBIRTH_1_PLUS].size
        },
        activeLocks: jobLocks.size,
        botsTracked: botHistory.size,
        reportsStored: reports.size,
        recentBrainrots: recentBrainrots.length,
        stats: stats
    });
});

app.get('/bots', (req, res) => {
    const bots = [];
    
    for (const [botName, history] of botHistory.entries()) {
        let lastJobId = null;
        let lastVisitedAt = 0;
        
        for (const [jobId, visitedAt] of history.entries()) {
            if (visitedAt > lastVisitedAt) {
                lastVisitedAt = visitedAt;
                lastJobId = jobId;
            }
        }
        
        let currentLock = null;
        for (const [jobId, lock] of jobLocks.entries()) {
            if (lock.botName === botName) {
                currentLock = jobId;
                break;
            }
        }
        
        bots.push({
            botName: botName,
            serversVisited: history.size,
            lastJobId: lastJobId ? lastJobId.slice(0, 12) + '...' : null,
            lastVisitedAgo: lastVisitedAt ? `${Math.floor((Date.now() - lastVisitedAt) / 1000)}s` : null,
            currentlyOn: currentLock ? currentLock.slice(0, 12) + '...' : null
        });
    }
    
    bots.sort((a, b) => b.serversVisited - a.serversVisited);
    
    res.json({
        totalBots: bots.length,
        bots: bots
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        pools: {
            rebirth0: pools[PLACES.REBIRTH_0].size,
            rebirth1plus: pools[PLACES.REBIRTH_1_PLUS].size
        }
    });
});

app.get('/pool', (req, res) => {
    const { key } = req.query;
    if (key !== API_KEY) return res.status(401).send('Unauthorized');
    
    const result = {};
    for (const [placeId, pool] of Object.entries(pools)) {
        result[placeId] = Array.from(pool.entries()).map(([jobId, info]) => ({
            jobId: jobId.slice(0, 12) + '...',
            players: info.players,
            maxPlayers: info.maxPlayers,
            ageSeconds: Math.floor((Date.now() - info.addedAt) / 1000)
        }));
    }
    
    res.json(result);
});

// ✅ NOUVEAU: API pour le dashboard frontend
app.get('/api/dashboard-data', (req, res) => {
    const now = Date.now();
    const botsArray = [];
    let activeBots = 0;
    let deadBots = 0;
    let slowBots = 0;
    
    for (const [botName, history] of botHistory.entries()) {
        let lastJobId = null;
        let lastVisitedAt = 0;
        
        for (const [jobId, visitedAt] of history.entries()) {
            if (visitedAt > lastVisitedAt) {
                lastVisitedAt = visitedAt;
                lastJobId = jobId;
            }
        }
        
        const lastVisitedAgo = Math.floor((now - lastVisitedAt) / 1000);
        const isDead = lastVisitedAgo > 300;
        const isActive = lastVisitedAgo < 30;
        const isSlow = !isDead && !isActive;
        
        if (isDead) deadBots++;
        else if (isActive) activeBots++;
        else slowBots++;
        
        let currentLock = null;
        for (const [jobId, lock] of jobLocks.entries()) {
            if (lock.botName === botName) {
                currentLock = jobId;
                break;
            }
        }
        
        const report = reports.get(botName);
        
        botsArray.push({
            botName,
            serversVisited: history.size,
            lastVisitedAgo,
            isActive,
            isDead,
            isSlow,
            currentJobId: currentLock,
            lastBrainrot: report ? {
                name: report.name,
                money: report.money,
                numeric: report.numeric,
                mutation: report.mutation,
                receivedAt: report.receivedAt
            } : null
        });
    }
    
    botsArray.sort((a, b) => b.serversVisited - a.serversVisited);
    
    res.json({
        stats: {
            totalBots: botsArray.length,
            activeBots,
            slowBots,
            deadBots,
            poolSize: pools[PLACES.REBIRTH_0].size + pools[PLACES.REBIRTH_1_PLUS].size,
            totalScans: stats.scansCompleted,
            totalAssignments: stats.successfulAssignments,
            reportsReceived: stats.reportsReceived,
            uptime: Math.floor((Date.now() - stats.startedAt) / 1000)
        },
        bots: botsArray,
        recentBrainrots: recentBrainrots.slice(0, 20)
    });
});

// ✅ NOUVEAU: DASHBOARD HTML
app.get('/dashboard', (req, res) => {
    res.send(getDashboardHTML());
});

app.get('/', (req, res) => {
    res.json({
        service: 'JobID Scanner - Smart Distribution + Dashboard',
        endpoints: [
            'GET /jobs?placeId=X&key=Y (header: username)',
            'GET /dashboard',
            'POST /report-data?key=Y',
            'GET /stats',
            'GET /bots',
            'GET /pool?key=Y',
            'GET /health',
            'POST /report-failed'
        ]
    });
});

// ═══════════════════════════════════════════════════════════════
//                    DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════

function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Flash Notifier Pro - Dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { 
    font-family: 'Inter', -apple-system, sans-serif; 
    background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
    color: #fff; min-height: 100vh; padding: 20px;
}
.container { max-width: 1400px; margin: 0 auto; }
h1 { 
    text-align: center; 
    background: linear-gradient(90deg, #00d4ff, #0070f3);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    font-size: 2.5em; margin-bottom: 5px;
}
.subtitle { text-align: center; color: #8b8fb1; margin-bottom: 30px; font-size: 0.9em; letter-spacing: 2px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 30px; }
.stat-card { 
    background: rgba(20, 25, 60, 0.6); backdrop-filter: blur(10px);
    border: 1px solid rgba(0, 212, 255, 0.2);
    border-radius: 12px; padding: 20px; text-align: center;
    transition: transform 0.2s;
}
.stat-card:hover { transform: translateY(-2px); border-color: #00d4ff; }
.stat-label { color: #8b8fb1; font-size: 0.75em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.stat-value { font-size: 2.2em; font-weight: 700; }
.stat-value.cyan { color: #00d4ff; }
.stat-value.green { color: #00ff88; }
.stat-value.red { color: #ff4757; }
.stat-value.orange { color: #ffa502; }
.stat-value.purple { color: #a55eea; }

.section { 
    background: rgba(20, 25, 60, 0.4); backdrop-filter: blur(10px);
    border: 1px solid rgba(0, 212, 255, 0.1);
    border-radius: 12px; padding: 25px; margin-bottom: 20px;
}
.section h2 { color: #00d4ff; margin-bottom: 20px; font-size: 1.3em; }
.filters { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
.filter-btn { 
    background: rgba(0, 212, 255, 0.1);
    border: 1px solid rgba(0, 212, 255, 0.3);
    color: #fff; padding: 8px 16px; border-radius: 8px;
    cursor: pointer; transition: all 0.2s; font-size: 0.85em;
}
.filter-btn:hover, .filter-btn.active { background: #00d4ff; color: #0a0e27; }

.bot-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.bot-card { 
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px; padding: 15px; transition: all 0.2s;
}
.bot-card.active { border-left: 3px solid #00ff88; }
.bot-card.slow { border-left: 3px solid #ffa502; }
.bot-card.dead { border-left: 3px solid #ff4757; opacity: 0.5; }
.bot-name { font-weight: 600; font-size: 1em; margin-bottom: 8px; }
.bot-info { display: flex; justify-content: space-between; font-size: 0.8em; color: #8b8fb1; margin-bottom: 4px; }
.bot-info span:last-child { color: #fff; }
.bot-status { 
    display: inline-block; padding: 2px 8px; border-radius: 6px;
    font-size: 0.7em; text-transform: uppercase; font-weight: 600; margin-bottom: 8px;
}
.status-active { background: rgba(0, 255, 136, 0.2); color: #00ff88; }
.status-slow { background: rgba(255, 165, 2, 0.2); color: #ffa502; }
.status-dead { background: rgba(255, 71, 87, 0.2); color: #ff4757; }

.brainrot-info { 
    background: rgba(0, 212, 255, 0.05); padding: 8px; border-radius: 6px;
    margin-top: 8px; font-size: 0.85em;
}
.brainrot-info strong { color: #00d4ff; }

.brainrot-list { display: grid; grid-template-columns: 1fr; gap: 8px; }
.brainrot-item { 
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 212, 255, 0.2);
    border-radius: 8px; padding: 12px;
    display: flex; justify-content: space-between; align-items: center;
}
.brainrot-name { color: #00d4ff; font-weight: 600; }
.brainrot-value { color: #00ff88; font-weight: 700; font-size: 1.1em; }

.footer { text-align: center; color: #8b8fb1; margin-top: 30px; font-size: 0.8em; }
.live-indicator { 
    display: inline-block; width: 8px; height: 8px;
    background: #00ff88; border-radius: 50%;
    margin-right: 6px; animation: pulse 1.5s infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.search-box { 
    width: 100%; padding: 10px 15px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 212, 255, 0.2);
    border-radius: 8px; color: #fff;
    font-size: 0.9em; margin-bottom: 15px;
}
.search-box:focus { outline: none; border-color: #00d4ff; }
</style>
</head>
<body>
<div class="container">
    <h1>⚡ FLASH NOTIFIER PRO</h1>
    <div class="subtitle"><span class="live-indicator"></span>BOT MONITOR DASHBOARD</div>
    
    <div class="stats" id="stats"></div>
    
    <div class="section">
        <h2>💎 Brainrots Trouvés (≥40M)</h2>
        <div class="brainrot-list" id="brainrots"></div>
    </div>
    
    <div class="section">
        <h2>🤖 Liste des Bots</h2>
        <input type="text" class="search-box" id="search" placeholder="🔍 Rechercher un bot..." />
        <div class="filters">
            <button class="filter-btn active" data-filter="all">Tous</button>
            <button class="filter-btn" data-filter="active">✅ Actifs</button>
            <button class="filter-btn" data-filter="slow">🟡 Lents</button>
            <button class="filter-btn" data-filter="dead">💀 Morts</button>
        </div>
        <div class="bot-list" id="bots"></div>
    </div>
    
    <div class="footer">Dev by SALAH ⚡ | Refresh auto: 5s</div>
</div>

<script>
let currentFilter = 'all';
let allBots = [];

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderBots();
    });
});

document.getElementById('search').addEventListener('input', renderBots);

function formatTime(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    return Math.floor(seconds / 3600) + 'h';
}

function renderBots() {
    const search = document.getElementById('search').value.toLowerCase();
    const filtered = allBots.filter(bot => {
        if (search && !bot.botName.toLowerCase().includes(search)) return false;
        if (currentFilter === 'active') return bot.isActive;
        if (currentFilter === 'slow') return bot.isSlow;
        if (currentFilter === 'dead') return bot.isDead;
        return true;
    });
    
    const html = filtered.map(bot => {
        const statusClass = bot.isDead ? 'dead' : (bot.isActive ? 'active' : 'slow');
        const statusText = bot.isDead ? '💀 MORT' : (bot.isActive ? '✅ ACTIF' : '🟡 LENT');
        const statusBg = bot.isDead ? 'status-dead' : (bot.isActive ? 'status-active' : 'status-slow');
        
        let brainrotHTML = '';
        if (bot.lastBrainrot) {
            brainrotHTML = '<div class="brainrot-info"><strong>' + bot.lastBrainrot.name + '</strong> - ' + bot.lastBrainrot.money + '</div>';
        }
        
        return '<div class="bot-card ' + statusClass + '">' +
            '<div class="bot-status ' + statusBg + '">' + statusText + '</div>' +
            '<div class="bot-name">' + bot.botName + '</div>' +
            '<div class="bot-info"><span>Serveurs scannés:</span><span>' + bot.serversVisited + '</span></div>' +
            '<div class="bot-info"><span>Dernier hop:</span><span>' + formatTime(bot.lastVisitedAgo) + '</span></div>' +
            (bot.currentJobId ? '<div class="bot-info"><span>JobID:</span><span>' + bot.currentJobId.substring(0, 12) + '...</span></div>' : '') +
            brainrotHTML +
        '</div>';
    }).join('');
    
    document.getElementById('bots').innerHTML = html || '<p style="color:#8b8fb1;text-align:center;">Aucun bot trouvé</p>';
}

async function fetchData() {
    try {
        const r = await fetch('/api/dashboard-data');
        const d = await r.json();
        
        document.getElementById('stats').innerHTML = 
            '<div class="stat-card"><div class="stat-label">Total Bots</div><div class="stat-value cyan">' + d.stats.totalBots + '</div></div>' +
            '<div class="stat-card"><div class="stat-label">✅ Actifs</div><div class="stat-value green">' + d.stats.activeBots + '</div></div>' +
            '<div class="stat-card"><div class="stat-label">🟡 Lents</div><div class="stat-value orange">' + d.stats.slowBots + '</div></div>' +
            '<div class="stat-card"><div class="stat-label">💀 Morts</div><div class="stat-value red">' + d.stats.deadBots + '</div></div>' +
            '<div class="stat-card"><div class="stat-label">Pool Serveurs</div><div class="stat-value purple">' + d.stats.poolSize + '</div></div>' +
            '<div class="stat-card"><div class="stat-label">Total Scans</div><div class="stat-value cyan">' + d.stats.totalScans + '</div></div>' +
            '<div class="stat-card"><div class="stat-label">Reports</div><div class="stat-value green">' + d.stats.reportsReceived + '</div></div>';
        
        if (d.recentBrainrots && d.recentBrainrots.length > 0) {
            document.getElementById('brainrots').innerHTML = d.recentBrainrots.map(b => 
                '<div class="brainrot-item">' +
                    '<div><div class="brainrot-name">' + (b.mutation ? '[' + b.mutation + '] ' : '') + b.name + '</div>' +
                    '<small style="color:#8b8fb1;">par ' + b.botName + '</small></div>' +
                    '<div class="brainrot-value">' + b.money + '</div>' +
                '</div>'
            ).join('');
        } else {
            document.getElementById('brainrots').innerHTML = '<p style="color:#8b8fb1;text-align:center;">Aucun brainrot trouvé pour l\\'instant</p>';
        }
        
        allBots = d.bots;
        renderBots();
    } catch (e) {
        console.error('Fetch error:', e);
    }
}

fetchData();
setInterval(fetchData, 5000);
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
//                    START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`🚀 JobID Scanner running on port ${PORT}`);
    console.log(`📊 Smart Distribution + Dashboard actif:`);
    console.log(`   - Lock JobID: ${JOBID_LOCK_TTL / 1000}s`);
    console.log(`   - History bot: ${BOT_HISTORY_TTL / 3600 / 1000}h`);
    console.log(`   - Cible: ${MIN_PLAYERS}-${MAX_PLAYERS} joueurs/8`);
    console.log(`   - Scan: toutes les ${SCAN_INTERVAL / 1000}s`);
    console.log(`   - Dashboard: /dashboard`);
    
    scannerLoop();
});
