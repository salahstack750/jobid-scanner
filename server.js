// ═══════════════════════════════════════════════════════════════
// 🚀 JOBID SCANNER + REPORTS + LOGS + DASHBOARD - Railway
// Dev by SALAH ⚡ | v3.5 - Que serveurs 7/8 (excludeFullGames)
// ═══════════════════════════════════════════════════════════════

const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';

const POOL_CONFIG = {
    rebirth0: { placeId: 96342491571673, label: 'Rebirth 0' },
    rebirth1plus: { placeId: 109983668079237, label: 'Rebirth 1+' }
};

// ✅ CONFIG MODIFIEE: Que des serveurs 7/8 (presque pleins)
const MIN_PLAYERS = 7;       // Au moins 7 joueurs
const MAX_PLAYERS = 7;       // Max 7 (pour laisser 1 place au bot)
const SCAN_INTERVAL = 15000;
const MAX_PAGES = 30;        // ✅ Scanner 30 pages = 3000 serveurs
const JOBID_LOCK_TTL = 90 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const BRAINROT_TTL = 60 * 1000;
const MAX_LOGS = 200;

// ✅ Liste de proxies (cascade fallback)
const PROXIES = [
    'https://roblox-proxy.salahelarabi03.workers.dev',
    'https://games.roproxy.com',
    'https://games.roblox.com'
];

const pools = {
    rebirth0: [],
    rebirth1plus: []
};

const jobLocks = new Map();
const botHistory = new Map();
const reports = new Map();
const recentBrainrots = [];
const liveLogs = [];

const stats = {
    totalScans: 0,
    jobsServed: 0,
    reportsReceived: 0,
    logsReceived: 0,
    startedAt: Date.now()
};

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
    
    for (const [jobId, lock] of jobLocks.entries()) {
        if (lock.expiresAt < now) jobLocks.delete(jobId);
    }
    
    for (const [botName, hist] of botHistory.entries()) {
        if (now - hist.lastSeen > BOT_HISTORY_TTL) botHistory.delete(botName);
    }
    
    for (let i = recentBrainrots.length - 1; i >= 0; i--) {
        if (recentBrainrots[i].expiresAt < now) {
            recentBrainrots.splice(i, 1);
        }
    }
}

setInterval(cleanupExpired, 5000);

// ═══════════════════════════════════════════════════════════════
// ✅ FETCH SERVERS avec excludeFullGames + multi-proxy fallback
// ═══════════════════════════════════════════════════════════════
async function fetchServers(placeId, cursor) {
    // ✅ NOUVEAU: excludeFullGames=true pour exclure les 8/8
    const path = '/v1/games/' + placeId + '/servers/Public?limit=100&excludeFullGames=true' + (cursor ? '&cursor=' + cursor : '');
    
    for (const proxy of PROXIES) {
        const url = proxy + path;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                }
            });
            clearTimeout(timeout);
            
            if (response.ok) {
                const data = await response.json();
                if (data && data.data) return data;
            }
        } catch (error) {
            // Try next proxy
        }
    }
    
    console.error('[SCAN] All proxies failed for ' + placeId);
    return null;
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
    console.log('[SCAN] ' + config.label + ': ' + newPool.length + ' serveurs 7/8');
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
        name: 'JobID Scanner + Logs',
        version: '3.5',
        config: {
            players: MIN_PLAYERS + '-' + MAX_PLAYERS,
            maxPages: MAX_PAGES,
            excludeFullGames: true
        },
        endpoints: ['/health', '/jobs', '/report-data', '/log', '/stats', '/bots', '/dashboard', '/api/dashboard-data', '/api/logs']
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
    
    const now = Date.now();
    const candidates = pool.filter(s => {
        const lock = jobLocks.get(s.jobId);
        if (lock && lock.expiresAt > now && lock.botName !== username) return false;
        if (botData.visitedJobs.has(s.jobId)) return false;
        return true;
    });
    
    if (candidates.length === 0) {
        botData.visitedJobs = new Set();
        return res.status(503).send('All visited');
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
    
    const body = req.body || {};
    const botName = body.botName;
    const jobId = body.jobId;
    const name = body.name;
    const money = body.money;
    const numeric = body.numeric || 0;
    const mutation = body.mutation;
    const players = body.players;
    const brainrots = body.brainrots || [];
    
    if (!botName) return res.status(400).json({ error: 'botName required' });
    
    stats.reportsReceived++;
    
    reports.set(botName, {
        botName: botName,
        jobId: jobId,
        lastBrainrot: { name: name, money: money, numeric: numeric, mutation: mutation },
        players: players,
        brainrots: brainrots,
        receivedAt: Date.now()
    });
    
    if (numeric >= 40000000 && name) {
        const now = Date.now();
        recentBrainrots.unshift({
            botName: botName,
            jobId: jobId,
            name: name,
            money: money,
            numeric: numeric,
            mutation: mutation,
            receivedAt: now,
            expiresAt: now + BRAINROT_TTL
        });
        
        if (recentBrainrots.length > 100) recentBrainrots.length = 100;
    }
    
    res.json({ ok: true });
});

app.post('/log', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const body = req.body || {};
    const botName = body.botName || 'unknown';
    const message = body.message || '';
    const level = body.level || 'INFO';
    
    if (!message) return res.status(400).json({ error: 'message required' });
    
    stats.logsReceived++;
    
    liveLogs.unshift({
        botName: botName,
        message: message,
        level: level,
        timestamp: Date.now()
    });
    
    if (liveLogs.length > MAX_LOGS) liveLogs.length = MAX_LOGS;
    
    res.json({ ok: true });
});

app.post('/report-failed', (req, res) => {
    if (!checkAuth(req, res)) return;
    const body = req.body || {};
    if (body.jobId) jobLocks.delete(body.jobId);
    res.json({ ok: true });
});

app.get('/stats', (req, res) => {
    res.json({
        totalScans: stats.totalScans,
        jobsServed: stats.jobsServed,
        reportsReceived: stats.reportsReceived,
        logsReceived: stats.logsReceived,
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1plus: pools.rebirth1plus.length
        },
        bots: botHistory.size,
        reports: reports.size
    });
});

app.get('/bots', (req, res) => {
    const now = Date.now();
    const list = [];
    
    for (const [botName, data] of botHistory.entries()) {
        const report = reports.get(botName);
        const sinceLastJob = (now - data.lastSeen) / 1000;
        
        list.push({
            botName: botName,
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

app.get('/api/logs', (req, res) => {
    const filter = (req.query.bot || '').toLowerCase();
    const limit = parseInt(req.query.limit) || 100;
    
    let logs = liveLogs;
    if (filter) {
        logs = logs.filter(l => l.botName.toLowerCase().includes(filter) || l.message.toLowerCase().includes(filter));
    }
    
    res.json(logs.slice(0, limit));
});

app.get('/api/dashboard-data', (req, res) => {
    const now = Date.now();
    
    let active = 0;
    let slow = 0;
    let dead = 0;
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
            botName: botName,
            jobsReceived: data.jobsReceived,
            currentJobId: data.currentJobId,
            lastSeenSeconds: Math.floor(sinceLastJob),
            isActive: isActive,
            isSlow: isSlow,
            isDead: isDead,
            lastBrainrot: report ? report.lastBrainrot : null,
            players: report ? report.players : null
        });
    }
    
    bots.sort((a, b) => b.jobsReceived - a.jobsReceived);
    
    const activeBrainrots = [];
    for (const b of recentBrainrots) {
        if (b.expiresAt > now) {
            activeBrainrots.push({
                botName: b.botName,
                jobId: b.jobId,
                name: b.name,
                money: b.money,
                numeric: b.numeric,
                mutation: b.mutation,
                remainingSeconds: Math.ceil((b.expiresAt - now) / 1000)
            });
        }
    }
    
    res.json({
        stats: {
            totalBots: botHistory.size,
            active: active,
            slow: slow,
            dead: dead,
            poolServers: pools.rebirth0.length + pools.rebirth1plus.length,
            totalScans: stats.totalScans,
            reportsReceived: stats.reportsReceived,
            logsReceived: stats.logsReceived
        },
        bots: bots,
        recentBrainrots: activeBrainrots
    });
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    
    const html = '<!DOCTYPE html>' +
'<html lang="fr"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>Flash Notifier Pro</title>' +
'<style>' +
'*{margin:0;padding:0;box-sizing:border-box;}' +
'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:linear-gradient(135deg,#0a0e1a,#1a1f2e);color:#fff;min-height:100vh;padding:20px;}' +
'.container{max-width:1400px;margin:0 auto;}' +
'.header{text-align:center;margin-bottom:30px;}' +
'.header h1{font-size:36px;background:linear-gradient(90deg,#00d4ff,#00ffaa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:900;}' +
'.header .subtitle{color:#00ffaa;margin-top:5px;font-size:12px;}' +
'.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:25px;}' +
'.stat-card{background:rgba(20,30,50,0.6);border:1px solid rgba(100,150,255,0.2);border-radius:12px;padding:16px;text-align:center;}' +
'.stat-label{font-size:10px;text-transform:uppercase;color:#888;margin-bottom:6px;letter-spacing:1px;}' +
'.stat-value{font-size:28px;font-weight:900;}' +
'.stat-card.total .stat-value{color:#00d4ff;}' +
'.stat-card.active .stat-value{color:#00ffaa;}' +
'.stat-card.slow .stat-value{color:#ffaa00;}' +
'.stat-card.dead .stat-value{color:#ff5555;}' +
'.stat-card.pool .stat-value{color:#aa55ff;}' +
'.stat-card.scans .stat-value{color:#00aaff;}' +
'.stat-card.reports .stat-value{color:#00ff77;}' +
'.stat-card.logs .stat-value{color:#ffd700;}' +
'.section{background:rgba(20,30,50,0.4);border:1px solid rgba(100,150,255,0.2);border-radius:12px;padding:20px;margin-bottom:20px;}' +
'.section-title{font-size:18px;font-weight:700;color:#00d4ff;margin-bottom:15px;}' +
'.brainrot-item{background:rgba(0,60,80,0.3);border-left:3px solid #00d4ff;border-radius:6px;padding:10px 14px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;position:relative;overflow:hidden;}' +
'.brainrot-info{flex:1;}' +
'.brainrot-name{font-size:13px;font-weight:700;color:#00d4ff;}' +
'.brainrot-bot{font-size:11px;color:#888;margin-top:2px;}' +
'.brainrot-meta{display:flex;align-items:center;gap:10px;}' +
'.brainrot-money{font-size:15px;font-weight:900;color:#00ff77;}' +
'.brainrot-timer{font-size:12px;font-weight:700;background:rgba(0,0,0,0.4);padding:3px 8px;border-radius:12px;min-width:50px;text-align:center;}' +
'.brainrot-timer.fresh{color:#00ffaa;}' +
'.brainrot-timer.medium{color:#ffaa00;}' +
'.brainrot-timer.expiring{color:#ff5555;animation:pulse 0.5s infinite;}' +
'.brainrot-progress{position:absolute;bottom:0;left:0;height:3px;background:linear-gradient(90deg,#00ffaa,#ffaa00,#ff5555);transition:width 1s linear;}' +
'@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.5;}}' +
'.search-bar{width:100%;background:rgba(10,15,25,0.6);border:1px solid rgba(100,150,255,0.3);border-radius:8px;padding:10px 15px;color:#fff;margin-bottom:12px;font-size:13px;}' +
'.filter-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;}' +
'.filter-tab{background:rgba(10,15,25,0.6);border:1px solid rgba(100,150,255,0.3);border-radius:8px;padding:6px 14px;color:#aaa;cursor:pointer;font-size:12px;font-weight:600;}' +
'.filter-tab.active{background:#00d4ff;color:#0a0e1a;border-color:#00d4ff;}' +
'.bots-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;}' +
'.bot-card{background:rgba(15,25,45,0.6);border-left:4px solid #444;border-radius:8px;padding:12px;}' +
'.bot-card.active{border-left-color:#00ffaa;}' +
'.bot-card.slow{border-left-color:#ffaa00;}' +
'.bot-card.dead{border-left-color:#ff5555;opacity:0.6;}' +
'.bot-status{font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;display:inline-block;margin-bottom:6px;}' +
'.bot-status.active{background:#00ffaa;color:#0a0e1a;}' +
'.bot-status.slow{background:#ffaa00;color:#0a0e1a;}' +
'.bot-status.dead{background:#ff5555;color:#fff;}' +
'.bot-name{font-weight:700;font-size:13px;margin-bottom:6px;cursor:pointer;}' +
'.bot-name:hover{color:#00d4ff;}' +
'.bot-stat{display:flex;justify-content:space-between;font-size:11px;color:#aaa;padding:1px 0;}' +
'.bot-stat .value{color:#fff;font-weight:600;}' +
'.bot-brainrot{margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1);font-size:11px;}' +
'.bot-brainrot .name{color:#00d4ff;font-weight:700;}' +
'.bot-brainrot .money{color:#00ff77;}' +
'.logs-container{background:#000;border-radius:8px;padding:12px;max-height:500px;overflow-y:auto;font-family:"Courier New",monospace;font-size:12px;}' +
'.log-entry{padding:4px 8px;border-radius:4px;margin-bottom:2px;display:flex;gap:10px;align-items:flex-start;}' +
'.log-entry:hover{background:rgba(255,255,255,0.05);}' +
'.log-time{color:#666;flex-shrink:0;min-width:60px;}' +
'.log-bot{color:#ffd700;font-weight:700;flex-shrink:0;min-width:120px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.log-level{flex-shrink:0;min-width:50px;font-weight:700;}' +
'.log-level.INFO{color:#00d4ff;}' +
'.log-level.WARN{color:#ffaa00;}' +
'.log-level.ERROR{color:#ff5555;}' +
'.log-message{color:#fff;flex:1;word-break:break-word;}' +
'.logs-controls{display:flex;gap:8px;margin-bottom:10px;align-items:center;}' +
'.logs-search{flex:1;background:rgba(10,15,25,0.6);border:1px solid rgba(100,150,255,0.3);border-radius:6px;padding:6px 10px;color:#fff;font-size:12px;}' +
'.logs-clear{background:#ff5555;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:700;}' +
'.logs-pause{background:#ffaa00;color:#0a0e1a;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:700;}' +
'.logs-pause.active{background:#00ffaa;}' +
'.logs-empty{color:#666;text-align:center;padding:20px;}' +
'.footer{text-align:center;margin-top:30px;color:#555;font-size:11px;}' +
'</style></head><body>' +
'<div class="container">' +
'<div class="header"><h1>FLASH NOTIFIER PRO</h1><div class="subtitle">BOT MONITOR DASHBOARD - LIVE LOGS - 7/8 ONLY</div></div>' +
'<div class="stats-grid">' +
'<div class="stat-card total"><div class="stat-label">TOTAL BOTS</div><div class="stat-value" id="stat-total">0</div></div>' +
'<div class="stat-card active"><div class="stat-label">ACTIFS</div><div class="stat-value" id="stat-active">0</div></div>' +
'<div class="stat-card slow"><div class="stat-label">LENTS</div><div class="stat-value" id="stat-slow">0</div></div>' +
'<div class="stat-card dead"><div class="stat-label">MORTS</div><div class="stat-value" id="stat-dead">0</div></div>' +
'<div class="stat-card pool"><div class="stat-label">POOL 7/8</div><div class="stat-value" id="stat-pool">0</div></div>' +
'<div class="stat-card scans"><div class="stat-label">SCANS</div><div class="stat-value" id="stat-scans">0</div></div>' +
'<div class="stat-card reports"><div class="stat-label">REPORTS</div><div class="stat-value" id="stat-reports">0</div></div>' +
'<div class="stat-card logs"><div class="stat-label">LOGS</div><div class="stat-value" id="stat-logs">0</div></div>' +
'</div>' +
'<div class="section"><div class="section-title">📜 Live Logs</div>' +
'<div class="logs-controls"><input type="text" class="logs-search" id="logs-search" placeholder="🔍 Filtrer..."><button class="logs-pause" id="logs-pause">⏸️ Pause</button><button class="logs-clear" id="logs-clear">🗑️ Clear</button></div>' +
'<div class="logs-container" id="logs-container"><div class="logs-empty">En attente...</div></div></div>' +
'<div class="section" id="brainrots-section" style="display:none;"><div class="section-title">💎 Brainrots (60s)</div><div id="brainrots-list"></div></div>' +
'<div class="section"><div class="section-title">🤖 Liste des Bots</div>' +
'<input type="text" class="search-bar" id="search" placeholder="Rechercher...">' +
'<div class="filter-tabs"><div class="filter-tab active" data-filter="all">Tous</div><div class="filter-tab" data-filter="active">✅ Actifs</div><div class="filter-tab" data-filter="slow">🟡 Lents</div><div class="filter-tab" data-filter="dead">💀 Morts</div></div>' +
'<div class="bots-grid" id="bots-grid"></div></div>' +
'<div class="footer">Dev by SALAH ⚡ | Refresh: 5s | Logs: 2s | Que serveurs 7/8</div>' +
'</div>' +
'<script>' +
'var currentFilter="all",searchTerm="",lastData=null,logsPaused=false,logsFilter="";' +
'document.querySelectorAll(".filter-tab").forEach(function(tab){tab.addEventListener("click",function(){document.querySelectorAll(".filter-tab").forEach(function(t){t.classList.remove("active");});tab.classList.add("active");currentFilter=tab.dataset.filter;if(lastData)renderBots(lastData.bots);});});' +
'document.getElementById("search").addEventListener("input",function(e){searchTerm=e.target.value.toLowerCase();if(lastData)renderBots(lastData.bots);});' +
'document.getElementById("logs-search").addEventListener("input",function(e){logsFilter=e.target.value.toLowerCase();fetchLogs();});' +
'document.getElementById("logs-pause").addEventListener("click",function(){logsPaused=!logsPaused;this.classList.toggle("active");this.textContent=logsPaused?"▶️ Resume":"⏸️ Pause";});' +
'document.getElementById("logs-clear").addEventListener("click",function(){document.getElementById("logs-container").innerHTML="<div class=\\"logs-empty\\">Effacé</div>";});' +
'function shortJobId(j){if(!j)return"-";return j.substring(0,12)+"...";}' +
'function formatTime(ts){return new Date(ts).toLocaleTimeString("fr-FR",{hour12:false});}' +
'function renderStats(s){document.getElementById("stat-total").textContent=s.totalBots;document.getElementById("stat-active").textContent=s.active;document.getElementById("stat-slow").textContent=s.slow;document.getElementById("stat-dead").textContent=s.dead;document.getElementById("stat-pool").textContent=s.poolServers;document.getElementById("stat-scans").textContent=s.totalScans;document.getElementById("stat-reports").textContent=s.reportsReceived;document.getElementById("stat-logs").textContent=s.logsReceived||0;}' +
'function renderBrainrots(brs){var section=document.getElementById("brainrots-section"),list=document.getElementById("brainrots-list");if(!brs||brs.length===0){section.style.display="none";return;}section.style.display="block";list.innerHTML="";brs.forEach(function(b){var r=b.remainingSeconds||0,tc="fresh";if(r<20)tc="medium";if(r<10)tc="expiring";var w=(r/60)*100,it=document.createElement("div");it.className="brainrot-item";it.dataset.expiresAt=Date.now()+(r*1000);var mt=b.mutation&&b.mutation!=="None"?"["+b.mutation+"] ":"";it.innerHTML="<div class=\\"brainrot-info\\"><div class=\\"brainrot-name\\">"+mt+b.name+"</div><div class=\\"brainrot-bot\\">par "+b.botName+"</div></div><div class=\\"brainrot-meta\\"><div class=\\"brainrot-money\\">"+b.money+"</div><div class=\\"brainrot-timer "+tc+"\\">"+r+"s</div></div><div class=\\"brainrot-progress\\" style=\\"width:"+w+"%\\"></div>";list.appendChild(it);});}' +
'function renderBots(bots){var grid=document.getElementById("bots-grid");grid.innerHTML="";var f=bots;if(currentFilter==="active")f=bots.filter(function(b){return b.isActive;});else if(currentFilter==="slow")f=bots.filter(function(b){return b.isSlow;});else if(currentFilter==="dead")f=bots.filter(function(b){return b.isDead;});if(searchTerm)f=f.filter(function(b){return b.botName.toLowerCase().indexOf(searchTerm)!==-1;});f.forEach(function(b){var sc="active",st="ACTIF";if(b.isDead){sc="dead";st="MORT";}else if(b.isSlow){sc="slow";st="LENT";}var c=document.createElement("div");c.className="bot-card "+sc;var bh="";if(b.lastBrainrot&&b.lastBrainrot.numeric>=20000000){var m=b.lastBrainrot.mutation&&b.lastBrainrot.mutation!=="None"?"["+b.lastBrainrot.mutation+"] ":"";bh="<div class=\\"bot-brainrot\\"><span class=\\"name\\">"+m+b.lastBrainrot.name+"</span><span class=\\"money\\"> - "+b.lastBrainrot.money+"</span></div>";}c.innerHTML="<span class=\\"bot-status "+sc+"\\">"+st+"</span><div class=\\"bot-name\\" onclick=\\"filterLogsByBot(\\\'"+b.botName+"\\\')\\">"+b.botName+"</div><div class=\\"bot-stat\\"><span>Scans:</span><span class=\\"value\\">"+b.jobsReceived+"</span></div><div class=\\"bot-stat\\"><span>Last hop:</span><span class=\\"value\\">"+b.lastSeenSeconds+"s</span></div><div class=\\"bot-stat\\"><span>JobID:</span><span class=\\"value\\">"+shortJobId(b.currentJobId)+"</span></div>"+bh;grid.appendChild(c);});}' +
'function filterLogsByBot(n){document.getElementById("logs-search").value=n;logsFilter=n.toLowerCase();fetchLogs();}' +
'function renderLogs(logs){if(logsPaused)return;var c=document.getElementById("logs-container");if(!logs||logs.length===0){c.innerHTML="<div class=\\"logs-empty\\">En attente...</div>";return;}c.innerHTML="";logs.forEach(function(l){var e=document.createElement("div");e.className="log-entry";var m=l.message.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");e.innerHTML="<span class=\\"log-time\\">"+formatTime(l.timestamp)+"</span><span class=\\"log-bot\\">"+l.botName+"</span><span class=\\"log-level "+l.level+"\\">"+l.level+"</span><span class=\\"log-message\\">"+m+"</span>";c.appendChild(e);});}' +
'function fetchData(){fetch("/api/dashboard-data").then(function(r){return r.json();}).then(function(d){lastData=d;renderStats(d.stats);renderBrainrots(d.recentBrainrots);renderBots(d.bots);}).catch(function(e){});}' +
'function fetchLogs(){if(logsPaused)return;var u="/api/logs?limit=100";if(logsFilter)u+="&bot="+encodeURIComponent(logsFilter);fetch(u).then(function(r){return r.json();}).then(function(l){renderLogs(l);}).catch(function(e){});}' +
'fetchData();fetchLogs();setInterval(fetchData,5000);setInterval(fetchLogs,2000);' +
'setInterval(function(){document.querySelectorAll(".brainrot-item").forEach(function(it){var ea=parseInt(it.dataset.expiresAt);if(!ea)return;var r=Math.max(0,Math.ceil((ea-Date.now())/1000)),te=it.querySelector(".brainrot-timer"),pe=it.querySelector(".brainrot-progress");if(te){te.textContent=r+"s";te.className="brainrot-timer "+(r<10?"expiring":r<20?"medium":"fresh");}if(pe)pe.style.width=((r/60)*100)+"%";if(r<=0)it.style.display="none";});},1000);' +
'</script></body></html>';
    
    res.send(html);
});

app.listen(PORT, () => {
    console.log('===============================================');
    console.log('JobID Scanner v3.5 - 7/8 ONLY + excludeFullGames');
    console.log('===============================================');
    console.log('Port: ' + PORT);
    console.log('Players: ' + MIN_PLAYERS + '-' + MAX_PLAYERS);
    console.log('Pages scan: ' + MAX_PAGES);
    console.log('Proxies: ' + PROXIES.length);
    console.log('===============================================');
    
    scanLoop();
});
