// ═══════════════════════════════════════════════════════════════
// 🚀 JOBID SCANNER + REPORTS + DASHBOARD - Railway
// Dev by SALAH ⚡ | v3 - Brainrots TTL 60s
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const POOL_CONFIG = {
    rebirth0: { placeId: 96342491571673, label: 'Rebirth 0' },
    rebirth1plus: { placeId: 109983668079237, label: 'Rebirth 1+' }
};

const MIN_PLAYERS = 6;
const MAX_PLAYERS = 7;
const SCAN_INTERVAL = 15000;
const MAX_PAGES = 10;
const JOBID_LOCK_TTL = 90 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const BRAINROT_TTL = 60 * 1000;  // ✅ 60 SECONDES

const CLOUDFLARE_PROXY = 'https://roblox-proxy.salahelarabi03.workers.dev';

// ═══════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════
const pools = {
    rebirth0: [],
    rebirth1plus: []
};

const jobLocks = new Map();
const botHistory = new Map();
const reports = new Map();
const recentBrainrots = [];  // ✅ Avec expiresAt

const stats = {
    totalScans: 0,
    jobsServed: 0,
    reportsReceived: 0,
    startedAt: Date.now()
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function checkAuth(req, res) {
    const key = req.query.key || req.headers['x-api-key'];
    if (key !== API_KEY) {
        res.status(401).json({ error: 'Invalid API key' });
        return false;
    }
    return true;
}

function cleanupExpired() {
    const now = Date.now();
    
    // Cleanup jobLocks
    for (const [jobId, lock] of jobLocks.entries()) {
        if (lock.expiresAt < now) jobLocks.delete(jobId);
    }
    
    // Cleanup botHistory
    for (const [botName, hist] of botHistory.entries()) {
        if (now - hist.lastSeen > BOT_HISTORY_TTL) botHistory.delete(botName);
    }
    
    // ✅ Cleanup brainrots expirés (>60s)
    for (let i = recentBrainrots.length - 1; i >= 0; i--) {
        if (recentBrainrots[i].expiresAt < now) {
            recentBrainrots.splice(i, 1);
        }
    }
}

setInterval(cleanupExpired, 5000);

// ═══════════════════════════════════════════════════════════════
// SCAN POOL
// ═══════════════════════════════════════════════════════════════
async function fetchServers(placeId, cursor = '') {
    const url = `${CLOUDFLARE_PROXY}/games/${placeId}/servers/Public?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    try {
        const response = await axios.get(url, { timeout: 8000 });
        return response.data;
    } catch (error) {
        console.error(`[SCAN] Erreur ${placeId}:`, error.message);
        return null;
    }
}

async function scanPool(poolKey) {
    const config = POOL_CONFIG[poolKey];
    if (!config) return;
    
    const newPool = [];
    let cursor = '';
    
    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await fetchServers(config.placeId, cursor);
        if (!data || !data.data) break;
        
        for (const server of data.data) {
            if (server.playing >= MIN_PLAYERS && server.playing <= MAX_PLAYERS) {
                newPool.push({
                    jobId: server.id,
                    players: server.playing,
                    maxPlayers: server.maxPlayers
                });
            }
        }
        
        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
        await new Promise(r => setTimeout(r, 200));
    }
    
    pools[poolKey] = newPool;
    stats.totalScans++;
    console.log(`[SCAN] ${config.label}: ${newPool.length} serveurs ${MIN_PLAYERS}-${MAX_PLAYERS}j`);
}

async function scanLoop() {
    while (true) {
        try {
            await Promise.all([
                scanPool('rebirth0'),
                scanPool('rebirth1plus')
            ]);
        } catch (e) {
            console.error('[SCAN] Erreur:', e.message);
        }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        name: 'JobID Scanner + Reports',
        version: '3.0',
        endpoints: {
            'GET /health': 'Status',
            'GET /jobs?placeId=X&key=KEY': 'Get JobID',
            'POST /report-data?key=KEY': 'Send brainrot report',
            'POST /report-failed?key=KEY': 'Report failed JobID',
            'GET /stats': 'Stats',
            'GET /bots': 'Bot list',
            'GET /pool?key=KEY': 'Pool details',
            'GET /api/dashboard-data': 'Dashboard JSON',
            'GET /dashboard': 'HTML Dashboard'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1plus: pools.rebirth1plus.length
        }
    });
});

app.get('/jobs', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const placeId = parseInt(req.query.placeId);
    const username = req.headers.username || 'anonymous';
    
    let poolKey;
    if (placeId === POOL_CONFIG.rebirth0.placeId) poolKey = 'rebirth0';
    else if (placeId === POOL_CONFIG.rebirth1plus.placeId) poolKey = 'rebirth1plus';
    else return res.status(400).send('Invalid placeId');
    
    const pool = pools[poolKey];
    if (!pool || pool.length === 0) {
        return res.status(503).send('Pool empty');
    }
    
    // Update bot history
    if (!botHistory.has(username)) {
        botHistory.set(username, {
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            jobsReceived: 0,
            currentJobId: null,
            visitedJobs: new Set()
        });
    }
    
    const botData = botHistory.get(username);
    botData.lastSeen = Date.now();
    botData.jobsReceived++;
    
    // Find unlocked job
    const now = Date.now();
    const candidates = pool.filter(s => {
        const lock = jobLocks.get(s.jobId);
        if (lock && lock.expiresAt > now && lock.botName !== username) return false;
        if (botData.visitedJobs.has(s.jobId)) return false;
        return true;
    });
    
    if (candidates.length === 0) {
        botData.visitedJobs = new Set();
        return res.status(503).send('All locked or visited');
    }
    
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    
    jobLocks.set(selected.jobId, {
        botName: username,
        expiresAt: now + JOBID_LOCK_TTL
    });
    
    botData.currentJobId = selected.jobId;
    botData.visitedJobs.add(selected.jobId);
    stats.jobsServed++;
    
    res.send(selected.jobId);
});

app.post('/report-data', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const { botName, jobId, name, money, numeric, mutation, players, brainrots } = req.body;
    
    if (!botName) return res.status(400).json({ error: 'botName required' });
    
    stats.reportsReceived++;
    
    // Save report
    reports.set(botName, {
        botName,
        jobId,
        lastBrainrot: { name, money, numeric, mutation },
        players,
        brainrots: brainrots || [],
        receivedAt: Date.now()
    });
    
    // ✅ Add brainrots ≥ 40M to recentBrainrots avec expiresAt
    if (numeric >= 40000000 && name) {
        const now = Date.now();
        recentBrainrots.unshift({
            botName,
            jobId,
            name,
            money,
            numeric,
            mutation,
            receivedAt: now,
            expiresAt: now + BRAINROT_TTL  // ✅ Expire dans 60s
        });
        
        // Limite max 100
        if (recentBrainrots.length > 100) recentBrainrots.length = 100;
    }
    
    res.json({ ok: true });
});

app.post('/report-failed', (req, res) => {
    if (!checkAuth(req, res)) return;
    const { jobId, botName } = req.body;
    if (jobId) jobLocks.delete(jobId);
    res.json({ ok: true });
});

app.get('/stats', (req, res) => {
    res.json({
        ...stats,
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1plus: pools.rebirth1plus.length
        },
        bots: botHistory.size,
        reports: reports.size,
        recentBrainrots: recentBrainrots.length
    });
});

app.get('/bots', (req, res) => {
    const now = Date.now();
    const list = [];
    
    for (const [botName, data] of botHistory.entries()) {
        const report = reports.get(botName);
        const sinceLastJob = (now - data.lastSeen) / 1000;
        
        list.push({
            botName,
            jobsReceived: data.jobsReceived,
            currentJobId: data.currentJobId,
            lastSeenSeconds: Math.floor(sinceLastJob),
            isActive: sinceLastJob < 30,
            isDead: sinceLastJob > 300,
            lastBrainrot: report ? report.lastBrainrot : null,
            players: report ? report.players : null
        });
    }
    
    list.sort((a, b) => b.jobsReceived - a.jobsReceived);
    res.json(list);
});

app.get('/pool', (req, res) => {
    if (!checkAuth(req, res)) return;
    res.json(pools);
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD JSON API
// ═══════════════════════════════════════════════════════════════
app.get('/api/dashboard-data', (req, res) => {
    const now = Date.now();
    
    let active = 0, slow = 0, dead = 0;
    const bots = [];
    
    for (const [botName, data] of botHistory.entries()) {
        const report = reports.get(botName);
        const sinceLastJob = (now - data.lastSeen) / 1000;
        
        const isActive = sinceLastJob < 30;
        const isSlow = sinceLastJob >= 30 && sinceLastJob < 300;
        const isDead = sinceLastJob >= 300;
        
        if (isActive) active++;
        else if (isSlow) slow++;
        else dead++;
        
        bots.push({
            botName,
            jobsReceived: data.jobsReceived,
            currentJobId: data.currentJobId,
            lastSeenSeconds: Math.floor(sinceLastJob),
            isActive,
            isSlow,
            isDead,
            lastBrainrot: report ? report.lastBrainrot : null,
            players: report ? report.players : null
        });
    }
    
    bots.sort((a, b) => b.jobsReceived - a.jobsReceived);
    
    // ✅ Filtrer les brainrots non-expirés et ajouter remainingSeconds
    const activeBrainrots = recentBrainrots
        .filter(b => b.expiresAt > now)
        .map(b => ({
            ...b,
            remainingSeconds: Math.ceil((b.expiresAt - now) / 1000)
        }));
    
    res.json({
        stats: {
            totalBots: botHistory.size,
            active,
            slow,
            dead,
            poolServers: pools.rebirth0.length + pools.rebirth1plus.length,
            totalScans: stats.totalScans,
            reportsReceived: stats.reportsReceived
        },
        bots,
        recentBrainrots: activeBrainrots
    });
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>⚡ Flash Notifier Pro</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #0a0e1a 0%, #1a1f2e 100%);
        color: #fff;
        min-height: 100vh;
        padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header {
        text-align: center;
        margin-bottom: 30px;
    }
    .header h1 {
        font-size: 36px;
        background: linear-gradient(90deg, #00d4ff, #00ffaa);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-weight: 900;
    }
    .header .subtitle {
        color: #00ffaa;
        margin-top: 5px;
        font-size: 12px;
    }
    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 15px;
        margin-bottom: 30px;
    }
    .stat-card {
        background: rgba(20, 30, 50, 0.6);
        border: 1px solid rgba(100, 150, 255, 0.2);
        border-radius: 12px;
        padding: 20px;
        text-align: center;
        backdrop-filter: blur(10px);
    }
    .stat-label {
        font-size: 11px;
        text-transform: uppercase;
        color: #888;
        margin-bottom: 8px;
        letter-spacing: 1px;
    }
    .stat-value {
        font-size: 32px;
        font-weight: 900;
    }
    .stat-card.total .stat-value { color: #00d4ff; }
    .stat-card.active .stat-value { color: #00ffaa; }
    .stat-card.slow .stat-value { color: #ffaa00; }
    .stat-card.dead .stat-value { color: #ff5555; }
    .stat-card.pool .stat-value { color: #aa55ff; }
    .stat-card.scans .stat-value { color: #00aaff; }
    .stat-card.reports .stat-value { color: #00ff77; }
    
    .section {
        background: rgba(20, 30, 50, 0.4);
        border: 1px solid rgba(100, 150, 255, 0.2);
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 20px;
    }
    .section-title {
        font-size: 18px;
        font-weight: 700;
        color: #00d4ff;
        margin-bottom: 15px;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    
    /* BRAINROTS LIST avec compteur 60s */
    .brainrot-item {
        background: rgba(0, 60, 80, 0.3);
        border-left: 3px solid #00d4ff;
        border-radius: 6px;
        padding: 12px 15px;
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        transition: all 0.3s ease;
        position: relative;
        overflow: hidden;
    }
    .brainrot-item::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        height: 3px;
        background: linear-gradient(90deg, #00ffaa, #ffaa00, #ff5555);
        transition: width 1s linear;
    }
    .brainrot-info { flex: 1; }
    .brainrot-name {
        font-size: 14px;
        font-weight: 700;
        color: #00d4ff;
    }
    .brainrot-bot {
        font-size: 11px;
        color: #888;
        margin-top: 2px;
    }
    .brainrot-meta {
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .brainrot-money {
        font-size: 16px;
        font-weight: 900;
        color: #00ff77;
    }
    .brainrot-timer {
        font-size: 13px;
        font-weight: 700;
        background: rgba(0, 0, 0, 0.4);
        padding: 4px 10px;
        border-radius: 12px;
        min-width: 50px;
        text-align: center;
    }
    .brainrot-timer.fresh { color: #00ffaa; }
    .brainrot-timer.medium { color: #ffaa00; }
    .brainrot-timer.expiring { color: #ff5555; animation: pulse 0.5s infinite; }
    
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
    }
    
    .search-bar {
        width: 100%;
        background: rgba(10, 15, 25, 0.6);
        border: 1px solid rgba(100, 150, 255, 0.3);
        border-radius: 8px;
        padding: 10px 15px;
        color: #fff;
        margin-bottom: 15px;
    }
    .search-bar:focus {
        outline: none;
        border-color: #00d4ff;
    }
    
    .filter-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 15px;
        flex-wrap: wrap;
    }
    .filter-tab {
        background: rgba(10, 15, 25, 0.6);
        border: 1px solid rgba(100, 150, 255, 0.3);
        border-radius: 8px;
        padding: 8px 16px;
        color: #aaa;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s;
    }
    .filter-tab.active {
        background: #00d4ff;
        color: #0a0e1a;
        border-color: #00d4ff;
    }
    
    .bots-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 12px;
    }
    .bot-card {
        background: rgba(15, 25, 45, 0.6);
        border-left: 4px solid #444;
        border-radius: 8px;
        padding: 14px;
        transition: all 0.2s;
    }
    .bot-card.active { border-left-color: #00ffaa; }
    .bot-card.slow { border-left-color: #ffaa00; }
    .bot-card.dead { border-left-color: #ff5555; opacity: 0.6; }
    
    .bot-status {
        font-size: 10px;
        font-weight: 700;
        padding: 3px 8px;
        border-radius: 4px;
        display: inline-block;
        margin-bottom: 8px;
    }
    .bot-status.active { background: #00ffaa; color: #0a0e1a; }
    .bot-status.slow { background: #ffaa00; color: #0a0e1a; }
    .bot-status.dead { background: #ff5555; color: #fff; }
    
    .bot-name {
        font-weight: 700;
        font-size: 14px;
        margin-bottom: 8px;
    }
    .bot-stat {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        color: #aaa;
        padding: 2px 0;
    }
    .bot-stat .value { color: #fff; font-weight: 600; }
    .bot-brainrot {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,0.1);
        font-size: 12px;
    }
    .bot-brainrot .name { color: #00d4ff; font-weight: 700; }
    .bot-brainrot .money { color: #00ff77; }
    
    .footer {
        text-align: center;
        margin-top: 30px;
        color: #555;
        font-size: 11px;
    }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>⚡ FLASH NOTIFIER PRO</h1>
        <div class="subtitle">● BOT MONITOR DASHBOARD</div>
    </div>
    
    <div class="stats-grid">
        <div class="stat-card total">
            <div class="stat-label">TOTAL BOTS</div>
            <div class="stat-value" id="stat-total">0</div>
        </div>
        <div class="stat-card active">
            <div class="stat-label">✅ ACTIFS</div>
            <div class="stat-value" id="stat-active">0</div>
        </div>
        <div class="stat-card slow">
            <div class="stat-label">🟡 LENTS</div>
            <div class="stat-value" id="stat-slow">0</div>
        </div>
        <div class="stat-card dead">
            <div class="stat-label">💀 MORTS</div>
            <div class="stat-value" id="stat-dead">0</div>
        </div>
        <div class="stat-card pool">
            <div class="stat-label">POOL SERVEURS</div>
            <div class="stat-value" id="stat-pool">0</div>
        </div>
        <div class="stat-card scans">
            <div class="stat-label">TOTAL SCANS</div>
            <div class="stat-value" id="stat-scans">0</div>
        </div>
        <div class="stat-card reports">
            <div class="stat-label">REPORTS</div>
            <div class="stat-value" id="stat-reports">0</div>
        </div>
    </div>
    
    <div class="section" id="brainrots-section" style="display: none;">
        <div class="section-title">💎 Brainrots Trouvés (≥40M) <span style="color:#888;font-size:11px;font-weight:400;">— restent 60s</span></div>
        <div id="brainrots-list"></div>
    </div>
    
    <div class="section">
        <div class="section-title">🤖 Liste des Bots</div>
        <input type="text" class="search-bar" id="search" placeholder="🔍 Rechercher un bot...">
        <div class="filter-tabs">
            <div class="filter-tab active" data-filter="all">Tous</div>
            <div class="filter-tab" data-filter="active">✅ Actifs</div>
            <div class="filter-tab" data-filter="slow">🟡 Lents</div>
            <div class="filter-tab" data-filter="dead">💀 Morts</div>
        </div>
        <div class="bots-grid" id="bots-grid"></div>
    </div>
    
    <div class="footer">Dev by SALAH ⚡ | Refresh auto: 5s | Brainrots TTL: 60s</div>
</div>

<script>
let currentFilter = 'all';
let searchTerm = '';
let lastData = null;

document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.dataset.filter;
        if (lastData) renderBots(lastData.bots);
    });
});

document.getElementById('search').addEventListener('input', e => {
    searchTerm = e.target.value.toLowerCase();
    if (lastData) renderBots(lastData.bots);
});

function shortJobId(jobId) {
    if (!jobId) return '-';
    return jobId.substring(0, 12) + '...';
}

function renderStats(stats) {
    document.getElementById('stat-total').textContent = stats.totalBots;
    document.getElementById('stat-active').textContent = stats.active;
    document.getElementById('stat-slow').textContent = stats.slow;
    document.getElementById('stat-dead').textContent = stats.dead;
    document.getElementById('stat-pool').textContent = stats.poolServers;
    document.getElementById('stat-scans').textContent = stats.totalScans;
    document.getElementById('stat-reports').textContent = stats.reportsReceived;
}

function renderBrainrots(brainrots) {
    const section = document.getElementById('brainrots-section');
    const list = document.getElementById('brainrots-list');
    
    if (!brainrots || brainrots.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    list.innerHTML = '';
    
    brainrots.forEach(b => {
        const remaining = b.remainingSeconds || 0;
        let timerClass = 'fresh';
        if (remaining < 20) timerClass = 'medium';
        if (remaining < 10) timerClass = 'expiring';
        
        const widthPct = (remaining / 60) * 100;
        
        const item = document.createElement('div');
        item.className = 'brainrot-item';
        item.style.setProperty('--width', widthPct + '%');
        
        const mutationText = b.mutation && b.mutation !== 'None' ? \`[\${b.mutation}] \` : '';
        
        item.innerHTML = \`
            <div class="brainrot-info">
                <div class="brainrot-name">\${mutationText}\${b.name}</div>
                <div class="brainrot-bot">par \${b.botName}</div>
            </div>
            <div class="brainrot-meta">
                <div class="brainrot-money">\${b.money}</div>
                <div class="brainrot-timer \${timerClass}">⏱ \${remaining}s</div>
            </div>
        \`;
        
        // Barre de progression visuelle
        const bar = document.createElement('div');
        bar.style.cssText = \`
            position: absolute;
            bottom: 0;
            left: 0;
            height: 3px;
            width: \${widthPct}%;
            background: linear-gradient(90deg, #00ffaa, #ffaa00, #ff5555);
            transition: width 1s linear;
        \`;
        item.appendChild(bar);
        
        list.appendChild(item);
    });
}

function renderBots(bots) {
    const grid = document.getElementById('bots-grid');
    grid.innerHTML = '';
    
    let filtered = bots;
    if (currentFilter === 'active') filtered = bots.filter(b => b.isActive);
    else if (currentFilter === 'slow') filtered = bots.filter(b => b.isSlow);
    else if (currentFilter === 'dead') filtered = bots.filter(b => b.isDead);
    
    if (searchTerm) {
        filtered = filtered.filter(b => b.botName.toLowerCase().includes(searchTerm));
    }
    
    filtered.forEach(bot => {
        let statusClass = 'active';
        let statusText = '✅ ACTIF';
        if (bot.isDead) { statusClass = 'dead'; statusText = '💀 MORT'; }
        else if (bot.isSlow) { statusClass = 'slow'; statusText = '🟡 LENT'; }
        
        const card = document.createElement('div');
        card.className = \`bot-card \${statusClass}\`;
        
        const brainrotHtml = bot.lastBrainrot && bot.lastBrainrot.numeric >= 20000000 ? \`
            <div class="bot-brainrot">
                <span class="name">\${bot.lastBrainrot.mutation && bot.lastBrainrot.mutation !== 'None' ? '[' + bot.lastBrainrot.mutation + '] ' : ''}\${bot.lastBrainrot.name}</span>
                <span class="money"> - \${bot.lastBrainrot.money}</span>
            </div>
        \` : '';
        
        card.innerHTML = \`
            <span class="bot-status \${statusClass}">\${statusText}</span>
            <div class="bot-name">\${bot.botName}</div>
            <div class="bot-stat"><span>Serveurs scannés:</span><span class="value">\${bot.jobsReceived}</span></div>
            <div class="bot-stat"><span>Dernier hop:</span><span class="value">\${bot.lastSeenSeconds}s</span></div>
            <div class="bot-stat"><span>JobID:</span><span class="value">\${shortJobId(bot.currentJobId)}</span></div>
            \${brainrotHtml}
        \`;
        
        grid.appendChild(card);
    });
}

async function fetchData() {
    try {
        const res = await fetch('/api/dashboard-data');
        const data = await res.json();
        lastData = data;
        
        renderStats(data.stats);
        renderBrainrots(data.recentBrainrots);
        renderBots(data.bots);
    } catch (e) {
        console.error('Fetch error:', e);
    }
}

fetchData();
setInterval(fetchData, 5000);

// Update timers locally chaque seconde (ne pas attendre le fetch)
setInterval(() => {
    if (!lastData || !lastData.recentBrainrots) return;
    
    document.querySelectorAll('.brainrot-timer').forEach((el, i) => {
        const b = lastData.recentBrainrots[i];
        if (!b) return;
        const elapsedSinceFetch = (Date.now() - lastData._fetchedAt) / 1000;
        const newRemaining = Math.max(0, b.remainingSeconds - Math.floor(elapsedSinceFetch));
        el.textContent = '⏱ ' + newRemaining + 's';
    });
}, 1000);

// Mark fetch time
const origFetch = fetchData;
fetchData = async function() {
    await origFetch();
    if (lastData) lastData._fetchedAt = Date.now();
};
</script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════');
    console.log('🚀 JobID Scanner v3 - Brainrots TTL 60s');
    console.log('═══════════════════════════════════════════════');
    console.log(`Port: ${PORT}`);
    console.log(`API Key: ${API_KEY}`);
    console.log(`Dashboard: /dashboard`);
    console.log('═══════════════════════════════════════════════');
    
    scanLoop();
});
