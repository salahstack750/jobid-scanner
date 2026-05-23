// ═══════════════════════════════════════════════════════════════
// 🦖 GODZILLA NOTIFIER - Railway Backend
// Modified by SALAH ⚡ | v5.0 FINAL - JobID unique + Players count
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

// ✅ CONFIG MODIFIEE
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 7;
const SCAN_INTERVAL = 15000;
const MAX_PAGES = 30;
const JOBID_LOCK_TTL = 90 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const BRAINROT_TTL = 30 * 1000;
const MIN_BRAINROT_VALUE = 1000000;  // ✅ 1M minimum (modifiable)
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
    console.log('[SCAN] ' + config.label + ': ' + newPool.length + ' serveurs');
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
        name: 'Godzilla Notifier Backend',
        version: '5.0 FINAL',
        config: {
            players: MIN_PLAYERS + '-' + MAX_PLAYERS,
            maxPages: MAX_PAGES,
            excludeFullGames: true,
            brainrotTTL: BRAINROT_TTL / 1000 + 's',
            minBrainrotValue: (MIN_BRAINROT_VALUE / 1000000) + 'M',
            uniqueJobIDs: true
        },
        endpoints: ['/health', '/jobs', '/report-data', '/log', '/stats', '/bots', '/dashboard', '/api/brainrots']
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

// ✅ MODIFIÉ: RETIRE LE JOBID DU POOL APRÈS DISTRIBUTION
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
    
    // ✅ NOUVEAU: RETIRER LE JOBID DU POOL (plus jamais redistribué)
    const poolArray = pools[poolKey];
    const poolIndex = poolArray.findIndex(s => s.jobId === selected.jobId);
    if (poolIndex !== -1) {
        poolArray.splice(poolIndex, 1);
        console.log('[JOBS] JobID retiré du pool. Reste:', poolArray.length);
    }
    
    jobLocks.set(selected.jobId, {
        botName: username,
        expiresAt: now + JOBID_LOCK_TTL
    });
    
    botData.currentJobId = selected.jobId;
    botData.visitedJobs.add(selected.jobId);
    stats.jobsServed++;
    
    res.send(selected.jobId);
});

// ✅ MODIFIÉ: Stocke le nombre de joueurs
app.post('/report-data', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const body = req.body || {};
    const botName = body.botName;
    const jobId = body.jobId;
    const name = body.name;
    const money = body.money;
    const numeric = body.numeric || 0;
    const mutation = body.mutation;
    const brainrots = body.brainrots;
    const source = body.source;
    const players = body.players;
    
    if (!botName || !jobId) {
        return res.status(400).json({ error: 'Missing botName or jobId' });
    }
    
    stats.reportsReceived++;
    
    const report = {
        botName: botName,
        jobId: jobId,
        name: name,
        money: money,
        numeric: numeric,
        mutation: mutation,
        brainrots: brainrots,
        source: source,
        players: players,
        timestamp: Date.now()
    };
    
    reports.set(botName + ':' + jobId, report);
    
    // ✅ MODIFIÉ: Ajoute TOUS les brainrots du tableau + players
    // ✅ FILTRE: Ne garde que les brainrots >= MIN_BRAINROT_VALUE
    if (Array.isArray(brainrots) && brainrots.length > 0) {
        const now = Date.now();
        
        for (const item of brainrots) {
            // ✅ Filtre par valeur minimale
            if (item.numeric >= MIN_BRAINROT_VALUE && item.name) {
                recentBrainrots.unshift({
                    botName: botName,
                    jobId: jobId,
                    name: item.name,
                    money: item.money,
                    numeric: item.numeric,
                    mutation: item.mutation || null,
                    source: item.source || 'unknown',
                    players: players || 0,
                    receivedAt: now,
                    expiresAt: now + BRAINROT_TTL
                });
            }
        }
        
        // Limite à 500 brainrots max (que des gros maintenant)
        if (recentBrainrots.length > 500) recentBrainrots.length = 500;
    }
    
    res.json({ success: true });
});

app.post('/log', (req, res) => {
    if (!checkAuth(req, res)) return;
    
    const body = req.body || {};
    const botName = body.botName || 'unknown';
    const message = body.message || '';
    
    if (!message) {
        return res.status(400).json({ error: 'Missing message' });
    }
    
    stats.logsReceived++;
    
    liveLogs.unshift({
        botName: botName,
        message: message,
        timestamp: Date.now()
    });
    
    if (liveLogs.length > MAX_LOGS) liveLogs.length = MAX_LOGS;
    
    res.json({ success: true });
});

app.get('/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    
    res.json({
        uptime: uptime,
        totalScans: stats.totalScans,
        jobsServed: stats.jobsServed,
        reportsReceived: stats.reportsReceived,
        logsReceived: stats.logsReceived,
        activeBots: botHistory.size,
        activeJobs: jobLocks.size,
        recentBrainrots: recentBrainrots.length,
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1plus: pools.rebirth1plus.length
        }
    });
});

app.get('/bots', (req, res) => {
    const bots = [];
    const now = Date.now();
    
    for (const [name, data] of botHistory.entries()) {
        const secondsSinceLastSeen = Math.floor((now - data.lastSeen) / 1000);
        bots.push({
            name: name,
            firstSeen: new Date(data.firstSeen).toISOString(),
            lastSeen: new Date(data.lastSeen).toISOString(),
            secondsSinceLastSeen: secondsSinceLastSeen,
            jobsReceived: data.jobsReceived,
            currentJobId: data.currentJobId,
            visitedJobsCount: data.visitedJobs.size
        });
    }
    
    bots.sort((a, b) => a.secondsSinceLastSeen - b.secondsSinceLastSeen);
    
    res.json(bots);
});

app.get('/pool', (req, res) => {
    const placeId = parseInt(req.query.placeId);
    
    let poolKey;
    if (placeId === POOL_CONFIG.rebirth0.placeId) poolKey = 'rebirth0';
    else if (placeId === POOL_CONFIG.rebirth1plus.placeId) poolKey = 'rebirth1plus';
    else {
        return res.json({
            rebirth0: {
                placeId: POOL_CONFIG.rebirth0.placeId,
                count: pools.rebirth0.length
            },
            rebirth1plus: {
                placeId: POOL_CONFIG.rebirth1plus.placeId,
                count: pools.rebirth1plus.length
            }
        });
    }
    
    const pool = pools[poolKey] || [];
    res.json({
        placeId: POOL_CONFIG[poolKey].placeId,
        count: pool.length,
        servers: pool
    });
});

// ✅ MODIFIÉ: API brainrots avec players
app.get('/api/brainrots', (req, res) => {
    const now = Date.now();
    const active = [];
    
    for (const b of recentBrainrots) {
        if (b.expiresAt > now) {
            active.push({
                botName: b.botName,
                jobId: b.jobId,
                name: b.name,
                money: b.money,
                numeric: b.numeric,
                mutation: b.mutation,
                source: b.source || 'unknown',
                players: b.players || 0,
                remainingSeconds: Math.ceil((b.expiresAt - now) / 1000)
            });
        }
    }
    
    res.json(active);
});

// ✅ DASHBOARD ULTRA PREMIUM AVEC PLAYERS
app.get('/dashboard', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🦖 Godzilla Notifier</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{
    font-family:'SF Mono','Monaco','Inconsolata','Courier New',monospace;
    background:#000000;
    color:#00ff00;
    min-height:100vh;
    padding:20px;
    overflow-x:hidden;
}
.bg-grid{
    position:fixed;
    top:0;
    left:0;
    width:100%;
    height:100%;
    background-image:
        linear-gradient(rgba(0,255,0,0.03) 1px,transparent 1px),
        linear-gradient(90deg,rgba(0,255,0,0.03) 1px,transparent 1px);
    background-size:50px 50px;
    z-index:-1;
    animation:grid-move 20s linear infinite;
}
@keyframes grid-move{
    0%{background-position:0 0;}
    100%{background-position:50px 50px;}
}
.container{
    max-width:1200px;
    margin:0 auto;
    position:relative;
    z-index:1;
}
.header{
    text-align:center;
    margin-bottom:40px;
    padding:30px;
    background:#000000;
    border:3px solid #00ff00;
    position:relative;
    overflow:hidden;
}
.header::before{
    content:'';
    position:absolute;
    top:-50%;
    left:-50%;
    width:200%;
    height:200%;
    background:repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0,255,0,0.03) 2px,
        rgba(0,255,0,0.03) 4px
    );
    animation:scan 8s linear infinite;
}
@keyframes scan{
    0%{transform:translateY(0);}
    100%{transform:translateY(50px);}
}
.header-content{
    position:relative;
    z-index:1;
}
.header h1{
    font-size:48px;
    color:#00ff00;
    text-shadow:
        0 0 10px #00ff00,
        0 0 20px #00ff00,
        0 0 30px #00ff00,
        0 0 40px #00ff00;
    margin-bottom:10px;
    letter-spacing:8px;
    font-weight:900;
    animation:glow-pulse 2s ease-in-out infinite;
}
@keyframes glow-pulse{
    0%,100%{text-shadow:0 0 10px #00ff00,0 0 20px #00ff00,0 0 30px #00ff00;}
    50%{text-shadow:0 0 20px #00ff00,0 0 30px #00ff00,0 0 40px #00ff00,0 0 50px #00ff00;}
}
.header .subtitle{
    font-size:14px;
    color:#00ff00;
    opacity:0.8;
    text-transform:uppercase;
    letter-spacing:4px;
    font-weight:600;
}
.stats-bar{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
    gap:15px;
    margin-bottom:30px;
}
.stat-box{
    background:#000000;
    border:2px solid #00ff00;
    padding:15px;
    text-align:center;
    position:relative;
    overflow:hidden;
}
.stat-box::before{
    content:'';
    position:absolute;
    top:0;
    left:-100%;
    width:100%;
    height:100%;
    background:linear-gradient(90deg,transparent,rgba(0,255,0,0.2),transparent);
    animation:stat-shine 3s infinite;
}
@keyframes stat-shine{
    0%{left:-100%;}
    100%{left:100%;}
}
.stat-label{
    font-size:10px;
    opacity:0.7;
    margin-bottom:5px;
    letter-spacing:2px;
}
.stat-value{
    font-size:24px;
    font-weight:900;
    color:#00ff00;
    text-shadow:0 0 10px #00ff00;
}
.empty{
    text-align:center;
    padding:100px 20px;
    color:#00ff00;
    font-size:20px;
    border:3px dashed #00ff00;
    background:#000000;
    opacity:0.3;
    text-transform:uppercase;
    letter-spacing:3px;
}
.brainrot-list{
    display:grid;
    gap:20px;
}
.brainrot-card{
    background:#000000;
    border:3px solid #00ff00;
    padding:25px;
    position:relative;
    overflow:hidden;
    transition:all 0.3s cubic-bezier(0.4,0,0.2,1);
    box-shadow:0 0 20px rgba(0,255,0,0.3);
}
.brainrot-card::before{
    content:'';
    position:absolute;
    top:0;
    left:0;
    width:6px;
    height:100%;
    background:#00ff00;
    box-shadow:0 0 10px #00ff00;
}
.top-brainrot::before{
    background:#ffd700 !important;
    box-shadow:0 0 15px #ffd700 !important;
}
.brainrot-card:hover{
    transform:translateX(5px);
    box-shadow:0 0 40px rgba(0,255,0,0.6);
    border-color:#00ff00;
}
.brainrot-header{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    margin-bottom:20px;
}
.brainrot-left{
    flex:1;
}
.brainrot-badges{
    display:flex;
    gap:8px;
    margin-bottom:12px;
    flex-wrap:wrap;
}
.badge{
    display:inline-block;
    padding:6px 12px;
    background:#00ff00;
    color:#000000;
    font-size:11px;
    font-weight:900;
    letter-spacing:1.5px;
    box-shadow:0 0 10px rgba(0,255,0,0.5);
}
.badge.source{
    background:#00ff00;
}
.badge.players{
    background:#00ff00;
}
.badge.top{
    background:#ffd700;
    color:#000000;
    animation:top-glow 1.5s ease-in-out infinite;
}
@keyframes top-glow{
    0%,100%{box-shadow:0 0 10px rgba(255,215,0,0.5);}
    50%{box-shadow:0 0 20px rgba(255,215,0,1),0 0 30px rgba(255,215,0,0.8);}
}
.top-brainrot{
    border-color:#ffd700 !important;
    box-shadow:0 0 30px rgba(255,215,0,0.5) !important;
}
.top-brainrot:hover{
    box-shadow:0 0 50px rgba(255,215,0,0.8) !important;
}
.brainrot-name{
    font-size:26px;
    font-weight:900;
    color:#ffffff;
    text-shadow:0 0 15px #00ff00;
    margin-bottom:8px;
    line-height:1.2;
}
.brainrot-value{
    font-size:42px;
    font-weight:900;
    color:#00ff00;
    text-shadow:
        0 0 10px #00ff00,
        0 0 20px #00ff00,
        0 0 30px #00ff00;
    letter-spacing:3px;
}
.brainrot-meta{
    display:flex;
    gap:20px;
    font-size:13px;
    color:#00ff00;
    opacity:0.8;
    margin-bottom:15px;
    flex-wrap:wrap;
}
.brainrot-meta span{
    display:flex;
    align-items:center;
    gap:6px;
}
.brainrot-footer{
    display:flex;
    gap:12px;
    align-items:center;
}
.btn-join{
    background:#00ff00;
    color:#000000;
    border:none;
    padding:12px 30px;
    font-size:16px;
    font-weight:900;
    cursor:pointer;
    transition:all 0.2s;
    letter-spacing:2px;
    font-family:inherit;
    box-shadow:0 0 15px rgba(0,255,0,0.5);
    position:relative;
    overflow:hidden;
}
.btn-join::before{
    content:'';
    position:absolute;
    top:50%;
    left:50%;
    width:0;
    height:0;
    background:rgba(255,255,255,0.3);
    border-radius:50%;
    transform:translate(-50%,-50%);
    transition:width 0.6s,height 0.6s;
}
.btn-join:hover::before{
    width:300px;
    height:300px;
}
.btn-join:hover{
    transform:scale(1.05);
    box-shadow:0 0 30px rgba(0,255,0,0.8);
}
.btn-join:active{
    transform:scale(0.95);
}
.brainrot-timer{
    background:#000000;
    border:2px solid #00ff00;
    padding:8px 16px;
    font-size:18px;
    font-weight:900;
    min-width:70px;
    text-align:center;
    box-shadow:0 0 10px rgba(0,255,0,0.3);
}
.timer-fresh{color:#00ff00;}
.timer-medium{color:#ffaa00;}
.timer-expiring{
    color:#ff5555;
    animation:timer-pulse 0.5s infinite;
}
@keyframes timer-pulse{
    0%,100%{opacity:1;transform:scale(1);}
    50%{opacity:0.5;transform:scale(1.1);}
}
.brainrot-progress{
    position:absolute;
    bottom:0;
    left:0;
    height:5px;
    background:#00ff00;
    transition:width 1s linear;
    box-shadow:0 0 15px #00ff00;
}
.footer{
    text-align:center;
    margin-top:50px;
    padding:25px;
    color:#00ff00;
    font-size:12px;
    opacity:0.4;
    border-top:2px solid #00ff00;
    text-transform:uppercase;
    letter-spacing:3px;
}
.copied-toast{
    position:fixed;
    top:30px;
    right:30px;
    background:#00ff00;
    color:#000000;
    padding:20px 30px;
    font-weight:900;
    font-size:16px;
    box-shadow:0 0 40px rgba(0,255,0,1);
    z-index:9999;
    animation:toast-in 0.3s ease;
    border:3px solid #000000;
}
@keyframes toast-in{
    from{transform:translateX(500px);opacity:0;}
    to{transform:translateX(0);opacity:1;}
}
</style>
</head>
<body>
<div class="bg-grid"></div>
<div class="container">
    <div class="header">
        <div class="header-content">
            <h1>🦖 GODZILLA NOTIFIER</h1>
            <div class="subtitle">BRAINROTS LIVE — TTL 30 SECONDES</div>
        </div>
    </div>
    
    <div class="stats-bar" id="stats-bar" style="display:none;">
        <div class="stat-box">
            <div class="stat-label">TOTAL BRAINROTS</div>
            <div class="stat-value" id="stat-total">0</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">ACTIFS (< 15S)</div>
            <div class="stat-value" id="stat-active">0</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">EXPIRANT (< 10S)</div>
            <div class="stat-value" id="stat-expiring">0</div>
        </div>
    </div>
    
    <div id="brainrots-container">
        <div class="empty">EN ATTENTE DE BRAINROTS...</div>
    </div>
    
    <div class="footer">
        Dev by SALAH ⚡ | Auto-refresh: 1s | JobID unique par bot
    </div>
</div>

<script>
function formatMoney(money) {
    return money || '$0';
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('✅ JOBID COPIÉ !');
    }).catch(() => {
        showToast('❌ ERREUR COPIE');
    });
}

function showToast(message) {
    const existing = document.querySelector('.copied-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = 'copied-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

function updateStats(brainrots) {
    if (!brainrots || brainrots.length === 0) {
        document.getElementById('stats-bar').style.display = 'none';
        return;
    }
    
    document.getElementById('stats-bar').style.display = 'grid';
    
    const total = brainrots.length;
    const active = brainrots.filter(b => b.remainingSeconds >= 15).length;
    const expiring = brainrots.filter(b => b.remainingSeconds < 10).length;
    
    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-active').textContent = active;
    document.getElementById('stat-expiring').textContent = expiring;
}

function renderBrainrots(brainrots) {
    const container = document.getElementById('brainrots-container');
    
    if (!brainrots || brainrots.length === 0) {
        container.innerHTML = '<div class="empty">EN ATTENTE DE BRAINROTS...</div>';
        updateStats(null);
        return;
    }
    
    updateStats(brainrots);
    
    // ✅ TRI PAR VALEUR DÉCROISSANTE (du plus gros au plus petit)
    const sortedBrainrots = brainrots.sort((a, b) => b.numeric - a.numeric);
    
    const list = document.createElement('div');
    list.className = 'brainrot-list';
    
    sortedBrainrots.forEach((b, index) => {
        const remaining = b.remainingSeconds || 0;
        const timerClass = remaining < 10 ? 'timer-expiring' : remaining < 20 ? 'timer-medium' : 'timer-fresh';
        const progressWidth = (remaining / 30) * 100;
        
        const card = document.createElement('div');
        card.className = 'brainrot-card';
        card.dataset.expiresAt = Date.now() + (remaining * 1000);
        
        // ✅ Ajouter classe spéciale pour le TOP 1
        if (index === 0) {
            card.classList.add('top-brainrot');
        }
        
        const mutationTag = b.mutation && b.mutation !== 'None' ? '[' + b.mutation + '] ' : '';
        const sourceTag = (b.source === 'carpet' ? 'CARPET' : b.source === 'plot' ? 'PLOT' : 'UNKNOWN').toUpperCase();
        const playersText = (b.players || 0) + '/8';
        
        // ✅ Badge TOP pour le meilleur
        const topBadge = index === 0 ? '<span class="badge top">🏆 TOP</span>' : '';
        
        card.innerHTML = \`
            <div class="brainrot-header">
                <div class="brainrot-left">
                    <div class="brainrot-badges">
                        \${topBadge}
                        <span class="badge source">\${sourceTag}</span>
                        <span class="badge players">👥 \${playersText}</span>
                    </div>
                    <div class="brainrot-name">\${mutationTag}\${b.name}</div>
                </div>
                <div class="brainrot-value">\${formatMoney(b.money)}</div>
            </div>
            <div class="brainrot-meta">
                <span>🤖 \${b.botName}</span>
                <span>🎮 \${b.jobId.substring(0, 16)}...</span>
            </div>
            <div class="brainrot-footer">
                <button class="btn-join" onclick="copyToClipboard('\${b.jobId}')">JOIN</button>
                <div class="brainrot-timer \${timerClass}">\${remaining}s</div>
            </div>
            <div class="brainrot-progress" style="width:\${progressWidth}%"></div>
        \`;
        
        list.appendChild(card);
    });
    
    container.innerHTML = '';
    container.appendChild(list);
}

function fetchBrainrots() {
    fetch('/api/brainrots')
        .then(r => r.json())
        .then(data => renderBrainrots(data))
        .catch(e => console.error('Fetch error:', e));
}

setInterval(() => {
    document.querySelectorAll('.brainrot-card').forEach(card => {
        const expiresAt = parseInt(card.dataset.expiresAt);
        if (!expiresAt) return;
        
        const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        const timerEl = card.querySelector('.brainrot-timer');
        const progressEl = card.querySelector('.brainrot-progress');
        
        if (timerEl) {
            timerEl.textContent = remaining + 's';
            timerEl.className = 'brainrot-timer ' + (remaining < 10 ? 'timer-expiring' : remaining < 20 ? 'timer-medium' : 'timer-fresh');
        }
        
        if (progressEl) {
            progressEl.style.width = ((remaining / 30) * 100) + '%';
        }
        
        if (remaining <= 0) {
            card.style.opacity = '0';
            card.style.transform = 'translateX(-20px)';
            setTimeout(() => card.remove(), 300);
        }
    });
}, 1000);

fetchBrainrots();
setInterval(fetchBrainrots, 1000);
</script>
</body>
</html>`;
    
    res.send(html);
});

app.listen(PORT, () => {
    console.log('===============================================');
    console.log('🦖 Godzilla Notifier Backend v5.0 FINAL');
    console.log('===============================================');
    console.log('Port: ' + PORT);
    console.log('Players: ' + MIN_PLAYERS + '-' + MAX_PLAYERS);
    console.log('Brainrot TTL: ' + (BRAINROT_TTL / 1000) + 's');
    console.log('Min value: ' + (MIN_BRAINROT_VALUE / 1000000) + 'M');
    console.log('Pages scan: ' + MAX_PAGES);
    console.log('JobID unique: OUI');
    console.log('===============================================');
    
    scanLoop();
});
