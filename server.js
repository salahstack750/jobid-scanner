// ═══════════════════════════════════════════════════════════════
// 🦖 GODZILLA NOTIFIER - Railway Backend
// Modified by SALAH ⚡ | v4.0 - Dashboard Ultra Simple + 30s TTL
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
const BRAINROT_TTL = 30 * 1000;  // ✅ MODIFIÉ: 30 secondes au lieu de 60
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
        version: '4.0',
        config: {
            players: MIN_PLAYERS + '-' + MAX_PLAYERS,
            maxPages: MAX_PAGES,
            excludeFullGames: true,
            brainrotTTL: BRAINROT_TTL / 1000 + 's'
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
    
    // ✅ Ajoute les brainrots à la liste (seuil à 0 pour tout capturer en test)
    if (numeric >= 0 && name) {
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

// ✅ NOUVEAU: API brainrots uniquement
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
                remainingSeconds: Math.ceil((b.expiresAt - now) / 1000)
            });
        }
    }
    
    res.json(active);
});

// ═══════════════════════════════════════════════════════════════
// 🦖 DASHBOARD ULTRA SIMPLE - BRAINROTS UNIQUEMENT
// ═══════════════════════════════════════════════════════════════
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    
    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🦖 Godzilla Notifier</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{
    font-family:'Courier New',monospace;
    background:#0a0a0a;
    color:#00ff00;
    min-height:100vh;
    padding:20px;
}
.container{
    max-width:900px;
    margin:0 auto;
}
.header{
    text-align:center;
    margin-bottom:30px;
    padding:20px;
    border:2px solid #00ff00;
    background:rgba(0,255,0,0.05);
}
.header h1{
    font-size:32px;
    color:#00ff00;
    text-shadow:0 0 10px #00ff00;
    margin-bottom:5px;
}
.header .subtitle{
    font-size:12px;
    color:#00aa00;
    opacity:0.8;
}
.empty{
    text-align:center;
    padding:60px 20px;
    color:#006600;
    font-size:16px;
    border:1px dashed #006600;
    background:rgba(0,255,0,0.02);
}
.brainrot-list{
    display:flex;
    flex-direction:column;
    gap:12px;
}
.brainrot-card{
    background:rgba(0,255,0,0.05);
    border:1px solid #00ff00;
    border-radius:8px;
    padding:16px;
    position:relative;
    overflow:hidden;
    transition:all 0.3s ease;
}
.brainrot-card:hover{
    background:rgba(0,255,0,0.1);
    box-shadow:0 0 20px rgba(0,255,0,0.3);
}
.brainrot-header{
    display:flex;
    justify-content:space-between;
    align-items:center;
    margin-bottom:10px;
}
.brainrot-name{
    font-size:18px;
    font-weight:bold;
    color:#00ff00;
}
.brainrot-value{
    font-size:20px;
    font-weight:bold;
    color:#00ff00;
    text-shadow:0 0 5px #00ff00;
}
.brainrot-meta{
    display:flex;
    gap:20px;
    font-size:13px;
    color:#00aa00;
}
.brainrot-meta span{
    display:flex;
    align-items:center;
    gap:5px;
}
.brainrot-timer{
    position:absolute;
    top:8px;
    right:8px;
    background:rgba(0,0,0,0.6);
    padding:4px 10px;
    border-radius:12px;
    font-size:14px;
    font-weight:bold;
}
.timer-fresh{color:#00ff00;}
.timer-medium{color:#ffaa00;}
.timer-expiring{color:#ff5555;animation:pulse 0.5s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.5;}}
.brainrot-progress{
    position:absolute;
    bottom:0;
    left:0;
    height:3px;
    background:linear-gradient(90deg,#00ff00,#ffaa00,#ff5555);
    transition:width 1s linear;
}
.footer{
    text-align:center;
    margin-top:30px;
    padding:15px;
    color:#006600;
    font-size:11px;
    border-top:1px solid #006600;
}
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>🦖 GODZILLA NOTIFIER</h1>
        <div class="subtitle">BRAINROTS LIVE - TTL 30 SECONDES</div>
    </div>
    
    <div id="brainrots-container">
        <div class="empty">En attente de brainrots...</div>
    </div>
    
    <div class="footer">
        Dev by SALAH ⚡ | Auto-refresh: 1s | Scan expire: 30s
    </div>
</div>

<script>
function formatMoney(money) {
    return money || '$0';
}

function renderBrainrots(brainrots) {
    const container = document.getElementById('brainrots-container');
    
    if (!brainrots || brainrots.length === 0) {
        container.innerHTML = '<div class="empty">En attente de brainrots...</div>';
        return;
    }
    
    const list = document.createElement('div');
    list.className = 'brainrot-list';
    
    brainrots.forEach(b => {
        const remaining = b.remainingSeconds || 0;
        const timerClass = remaining < 10 ? 'timer-expiring' : remaining < 20 ? 'timer-medium' : 'timer-fresh';
        const progressWidth = (remaining / 30) * 100;
        
        const card = document.createElement('div');
        card.className = 'brainrot-card';
        card.dataset.expiresAt = Date.now() + (remaining * 1000);
        
        const mutationTag = b.mutation && b.mutation !== 'None' ? '[' + b.mutation + ']' : '';
        
        card.innerHTML = \`
            <div class="brainrot-timer \${timerClass}">\${remaining}s</div>
            <div class="brainrot-header">
                <div class="brainrot-name">\${mutationTag} \${b.name}</div>
                <div class="brainrot-value">\${formatMoney(b.money)}</div>
            </div>
            <div class="brainrot-meta">
                <span>🤖 \${b.botName}</span>
                <span>🎮 JobID: \${b.jobId.substring(0, 12)}...</span>
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

// Update timers every second
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
            setTimeout(() => card.remove(), 300);
        }
    });
}, 1000);

// Fetch brainrots every second
fetchBrainrots();
setInterval(fetchBrainrots, 1000);
</script>
</body>
</html>`;
    
    res.send(html);
});

app.listen(PORT, () => {
    console.log('===============================================');
    console.log('🦖 Godzilla Notifier Backend v4.0');
    console.log('===============================================');
    console.log('Port: ' + PORT);
    console.log('Players: ' + MIN_PLAYERS + '-' + MAX_PLAYERS);
    console.log('Brainrot TTL: ' + (BRAINROT_TTL / 1000) + 's');
    console.log('Pages scan: ' + MAX_PAGES);
    console.log('===============================================');
    
    scanLoop();
});
