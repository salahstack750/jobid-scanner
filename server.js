// Godzilla Notifier Backend - OPTI MAX v6.1
// FINAL: 5s refresh + 100 pages + Promise.any proxies.txt + fresh pool
// Modified by SALAH

const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';

const POOL_CONFIG = {
    rebirth1plus: { placeId: 109983668079237, label: 'Rebirth 1+' }
};

// ============================================================
// CONFIG
// ============================================================

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 7;
const SCAN_INTERVAL = 5000;      // ✅ refresh toutes les 5 secondes
const MAX_PAGES = 100;           // ✅ 100 pages = max serveurs possible
const JOBID_LOCK_TTL = 30 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const BRAINROT_TTL = 30 * 1000;
const MIN_BRAINROT_VALUE = 1000000;
const MAX_LOGS = 200;

const FILTERING_ENABLED = true;
const MIN_FPS = 35;
const MAX_PING = 500;
const TOP_DISTRIBUTION_RATIO = 0.7;

// ============================================================
// CHARGEMENT PROXIES depuis proxies.txt
// ============================================================

let PROXIES = [];

function loadProxies() {
    try {
        const raw = fs.readFileSync('proxies.txt', 'utf8');
        const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        // Dédoublonnage (ton fichier a des doublons)
        const unique = [...new Set(lines)];
        PROXIES = unique;
        console.log('[PROXIES] ' + PROXIES.length + ' proxies uniques chargés depuis proxies.txt');
    } catch (e) {
        console.warn('[PROXIES] proxies.txt introuvable, fallback sur proxies par défaut');
        PROXIES = [
            'https://roblox-proxy.salahelarabi03.workers.dev',
            'https://games.roproxy.com',
            'https://games.roblox.com'
        ];
    }
}

// Convertit une ligne "user:pass@host:port" en URL proxy HTTP
function proxyLineToUrl(line) {
    // Format nettify: "user:pass@host:port"
    if (line.startsWith('http://') || line.startsWith('https://')) return line;
    return 'http://' + line;
}

// ============================================================
// STATE
// ============================================================

const pools = {
    rebirth1plus: []
};

const poolQualityStats = {
    rebirth1plus: { avgFps: 0, avgPing: 0, avgScore: 0, filtered: 0, total: 0 }
};

const jobLocks = new Map();
const botHistory = new Map();
const reports = new Map();
const recentBrainrots = [];
const liveLogs = [];

const stats = {
    totalScans: 0,
    jobsServed: 0,
    jobsServedTopScore: 0,
    jobsServedRandom: 0,
    reportsReceived: 0,
    reportsWithBrainrots: 0,
    logsReceived: 0,
    startedAt: Date.now()
};

// ============================================================
// SCORING
// ============================================================

function calculateServerScore(server) {
    let score = 100;

    if (server.fps !== undefined && server.fps !== null) {
        if (server.fps < 30) score -= 80;
        else if (server.fps < 45) score -= 50;
        else if (server.fps < 55) score -= 20;
        else if (server.fps >= 58) score += 20;
    }

    if (server.ping !== undefined && server.ping !== null) {
        if (server.ping > 500) score -= 50;
        else if (server.ping > 200) score -= 20;
        else if (server.ping < 80) score += 10;
    }

    if (server.players === 7) score += 15;
    else if (server.players === 6) score += 5;
    else if (server.players === 5) score -= 5;

    return score;
}

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
        if (recentBrainrots[i].expiresAt < now) recentBrainrots.splice(i, 1);
    }
}

setInterval(cleanupExpired, 5000);

// ============================================================
// FETCH SERVERS — Promise.any() : tous les proxies en parallèle
// ============================================================

async function fetchServers(placeId, cursor) {
    if (PROXIES.length === 0) return null;

    const path = '/v1/games/' + placeId + '/servers/Public?limit=100&excludeFullGames=true' + (cursor ? '&cursor=' + cursor : '');

    const result = await Promise.any(
        PROXIES.map(async (proxyLine) => {
            const proxyUrl = proxyLineToUrl(proxyLine);
            // Pour les proxies HTTP auth (nettify format), on fait la requête via l'URL proxy
            const targetUrl = proxyUrl.includes('@')
                ? proxyUrl + path  // proxy qui préfixe l'URL (roproxy style)
                : proxyUrl + path;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000); // 4s max par proxy

            try {
                const response = await fetch(targetUrl, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });
                clearTimeout(timeout);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const data = await response.json();
                if (!data || !data.data) throw new Error('No data');
                return data;
            } catch (e) {
                clearTimeout(timeout);
                throw e;
            }
        })
    ).catch(() => null);

    if (!result) {
        console.error('[SCAN] All proxies failed for ' + placeId);
    }

    return result;
}

// ============================================================
// SCAN POOL — fresh list + conserve si scan vide
// ============================================================

async function scanPool(poolKey) {
    const config = POOL_CONFIG[poolKey];
    if (!config) return;

    const newPool = [];
    let cursor = '';
    let totalScanned = 0;
    let filteredOut = 0;
    let sumFps = 0;
    let sumPing = 0;
    let sumScore = 0;
    let pagesScanned = 0;  // combien de pages ont répondu

    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await fetchServers(config.placeId, cursor);
        if (!data || !data.data) break;

        pagesScanned++;

        for (const server of data.data) {
            if (server.playing >= MIN_PLAYERS && server.playing <= MAX_PLAYERS) {
                totalScanned++;

                if (FILTERING_ENABLED) {
                    if (server.fps !== undefined && server.fps < MIN_FPS) {
                        filteredOut++;
                        continue;
                    }
                    if (server.ping !== undefined && server.ping > MAX_PING) {
                        filteredOut++;
                        continue;
                    }
                }

                const serverData = {
                    jobId: server.id,
                    players: server.playing,
                    maxPlayers: server.maxPlayers,
                    fps: server.fps,
                    ping: server.ping
                };

                serverData.score = calculateServerScore(serverData);
                newPool.push(serverData);

                if (server.fps) sumFps += server.fps;
                if (server.ping) sumPing += server.ping;
                sumScore += serverData.score;
            }
        }

        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
        await new Promise(r => setTimeout(r, 100)); // petit délai inter-pages
    }

    // ✅ Si aucun proxy n'a répondu → conserver le pool existant
    if (pagesScanned === 0) {
        console.log('[SCAN] ' + config.label + ': tous proxies dead, pool conservé (' + pools[poolKey].length + ' serveurs)');
        return;
    }

    // ✅ Sinon → remplacer par liste FRESH triée par score (pas de merge)
    newPool.sort((a, b) => b.score - a.score);
    pools[poolKey] = newPool;

    if (newPool.length > 0) {
        poolQualityStats[poolKey] = {
            avgFps: Math.round((sumFps / newPool.length) * 10) / 10,
            avgPing: Math.round(sumPing / newPool.length),
            avgScore: Math.round(sumScore / newPool.length),
            filtered: filteredOut,
            total: totalScanned
        };
    }

    stats.totalScans++;

    const topScore = newPool.length > 0 ? newPool[0].score : 0;
    const bottomScore = newPool.length > 0 ? newPool[newPool.length - 1].score : 0;

    console.log('[SCAN] ' + config.label + ': ' + newPool.length + ' serveurs FRESH | Pages: ' + pagesScanned + ' | Filtrés: ' + filteredOut + ' | Score top: ' + topScore + ' bottom: ' + bottomScore);
}

async function scanLoop() {
    while (true) {
        try {
            await scanPool('rebirth1plus');
        } catch (e) {
            console.error('[SCAN] Erreur:', e.message);
        }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/', (req, res) => {
    res.json({
        name: 'Godzilla Notifier Backend',
        version: '6.1 OPTI MAX FINAL',
        config: {
            players: MIN_PLAYERS + '-' + MAX_PLAYERS,
            scanInterval: SCAN_INTERVAL + 'ms',
            maxPages: MAX_PAGES,
            jobIdLockTTL: JOBID_LOCK_TTL + 'ms',
            filteringEnabled: FILTERING_ENABLED,
            minFps: MIN_FPS,
            maxPing: MAX_PING,
            topDistributionRatio: (TOP_DISTRIBUTION_RATIO * 100) + '%',
            brainrotTTL: BRAINROT_TTL / 1000 + 's',
            minBrainrotValue: (MIN_BRAINROT_VALUE / 1000000) + 'M',
            proxiesLoaded: PROXIES.length
        },
        endpoints: ['/health', '/jobs', '/report-data', '/log', '/stats', '/bots', '/dashboard', '/api/brainrots', '/pool-quality', '/live-monitor']
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        proxies: PROXIES.length,
        pools: {
            rebirth1plus: pools.rebirth1plus.length
        }
    });
});

app.get('/jobs', (req, res) => {
    if (!checkAuth(req, res)) return;

    const placeId = parseInt(req.query.placeId);
    const username = req.headers.username || 'anonymous';

    let poolKey;
    if (placeId === POOL_CONFIG.rebirth1plus.placeId) poolKey = 'rebirth1plus';
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

    let selected;
    const useTopScore = Math.random() < TOP_DISTRIBUTION_RATIO;

    if (useTopScore && candidates.length > 0) {
        const topSize = Math.max(1, Math.floor(candidates.length * 0.3));
        const topCandidates = candidates.slice(0, topSize);
        selected = topCandidates[Math.floor(Math.random() * topCandidates.length)];
        stats.jobsServedTopScore++;
    } else {
        selected = candidates[Math.floor(Math.random() * candidates.length)];
        stats.jobsServedRandom++;
    }

    const poolArray = pools[poolKey];
    const poolIndex = poolArray.findIndex(s => s.jobId === selected.jobId);
    if (poolIndex !== -1) poolArray.splice(poolIndex, 1);

    jobLocks.set(selected.jobId, {
        botName: username,
        expiresAt: now + JOBID_LOCK_TTL
    });

    botData.currentJobId = selected.jobId;
    botData.visitedJobs.add(selected.jobId);
    stats.jobsServed++;

    const fpsStr = selected.fps ? selected.fps.toFixed(1) : 'N/A';
    const pingStr = selected.ping !== undefined ? selected.ping + 'ms' : 'N/A';
    console.log('[JOBS] ' + username + ' -> ' + selected.jobId.substring(0, 12) + '... | FPS:' + fpsStr + ' Ping:' + pingStr + ' Score:' + selected.score + ' Players:' + selected.players + '/8 (' + (useTopScore ? 'TOP' : 'RND') + ') | Pool reste: ' + poolArray.length);

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
    const brainrots = body.brainrots;
    const source = body.source;
    const players = body.players;

    if (!botName || !jobId) {
        return res.status(400).json({ error: 'Missing botName or jobId' });
    }

    stats.reportsReceived++;

    let hasValidBrainrot = false;

    reports.set(botName + ':' + jobId, {
        botName, jobId, name, money, numeric, mutation, brainrots, source, players,
        timestamp: Date.now()
    });

    if (Array.isArray(brainrots) && brainrots.length > 0) {
        const now = Date.now();

        for (const item of brainrots) {
            if (item.numeric >= MIN_BRAINROT_VALUE && item.name) {
                hasValidBrainrot = true;

                const isDuplicate = recentBrainrots.some(existing =>
                    existing.name === item.name &&
                    existing.numeric === item.numeric &&
                    existing.jobId === jobId &&
                    existing.expiresAt > now
                );

                if (!isDuplicate) {
                    recentBrainrots.unshift({
                        botName, jobId,
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
        }
    }

    if (hasValidBrainrot) stats.reportsWithBrainrots++;

    res.json({ success: true });
});

app.post('/log', (req, res) => {
    if (!checkAuth(req, res)) return;

    const body = req.body || {};
    const botName = body.botName || 'unknown';
    const message = body.message || '';

    if (!message) return res.status(400).json({ error: 'Missing message' });

    stats.logsReceived++;

    liveLogs.unshift({ botName, message, timestamp: Date.now() });
    if (liveLogs.length > MAX_LOGS) liveLogs.length = MAX_LOGS;

    res.json({ success: true });
});

app.get('/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    const uptimeMin = uptime / 60;

    res.json({
        uptime,
        totalScans: stats.totalScans,
        jobsServed: stats.jobsServed,
        jobsServedTopScore: stats.jobsServedTopScore,
        jobsServedRandom: stats.jobsServedRandom,
        jobsPerMinute: uptimeMin > 0 ? Math.round(stats.jobsServed / uptimeMin) : 0,
        reportsReceived: stats.reportsReceived,
        reportsWithBrainrots: stats.reportsWithBrainrots,
        reportsHitRate: stats.reportsReceived > 0 ? Math.round((stats.reportsWithBrainrots / stats.reportsReceived) * 100) + '%' : '0%',
        reportsPerMinute: uptimeMin > 0 ? Math.round(stats.reportsReceived / uptimeMin) : 0,
        logsReceived: stats.logsReceived,
        activeBots: botHistory.size,
        activeJobs: jobLocks.size,
        recentBrainrots: recentBrainrots.length,
        proxies: PROXIES.length,
        pools: {
            rebirth1plus: pools.rebirth1plus.length
        },
        quality: poolQualityStats,
        config: {
            filteringEnabled: FILTERING_ENABLED,
            minFps: MIN_FPS,
            maxPing: MAX_PING,
            topRatio: TOP_DISTRIBUTION_RATIO
        }
    });
});

app.get('/pool-quality', (req, res) => {
    const result = {};

    for (const [poolKey, pool] of Object.entries(pools)) {
        const top10 = pool.slice(0, 10).map(s => ({
            jobId: s.jobId.substring(0, 16) + '...',
            score: s.score,
            fps: s.fps ? Math.round(s.fps * 10) / 10 : null,
            ping: s.ping,
            players: s.players
        }));

        const bottom10 = pool.slice(-10).reverse().map(s => ({
            jobId: s.jobId.substring(0, 16) + '...',
            score: s.score,
            fps: s.fps ? Math.round(s.fps * 10) / 10 : null,
            ping: s.ping,
            players: s.players
        }));

        result[poolKey] = {
            total: pool.length,
            quality: poolQualityStats[poolKey],
            top10,
            bottom10
        };
    }

    res.json(result);
});

app.get('/bots', (req, res) => {
    const bots = [];
    const now = Date.now();

    for (const [name, data] of botHistory.entries()) {
        const secondsSinceLastSeen = Math.floor((now - data.lastSeen) / 1000);
        bots.push({
            name,
            firstSeen: new Date(data.firstSeen).toISOString(),
            lastSeen: new Date(data.lastSeen).toISOString(),
            secondsSinceLastSeen,
            jobsReceived: data.jobsReceived,
            currentJobId: data.currentJobId,
            visitedJobsCount: data.visitedJobs.size
        });
    }

    bots.sort((a, b) => a.secondsSinceLastSeen - b.secondsSinceLastSeen);
    res.json(bots);
});

app.get('/pool', (req, res) => {
    const pool = pools.rebirth1plus || [];
    res.json({
        placeId: POOL_CONFIG.rebirth1plus.placeId,
        count: pool.length,
        quality: poolQualityStats.rebirth1plus,
        servers: pool.slice(0, 50)
    });
});

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

// ============================================================
// LIVE MONITOR
// ============================================================
app.get('/live-monitor', (req, res) => {
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Live Monitor</title><style>* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: Courier New, monospace; background: #0a0a0a; color: #00ff00; padding: 20px; } h1 { text-align: center; margin-bottom: 20px; text-shadow: 0 0 10px #00ff00; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; margin-bottom: 20px; } .box { background: #111; border: 1px solid #00ff00; padding: 15px; } .box h3 { color: #ffff00; margin-bottom: 10px; font-size: 14px; } .box .val { font-size: 32px; font-weight: bold; } .box .sub { font-size: 11px; opacity: 0.7; margin-top: 5px; } table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 11px; } th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #002200; } th { background: #001100; color: #ffff00; } .good { color: #00ff00; } .bad { color: #ff0000; } .warn { color: #ffaa00; } .refresh { text-align: center; opacity: 0.5; font-size: 10px; margin-top: 20px; }</style></head><body><h1>GODZILLA OPTI MAX v6.1 - LIVE MONITOR</h1><div id="content">Loading...</div><div class="refresh">Auto-refresh: 2s</div><script>async function refresh(){const[s,q,b]=await Promise.all([fetch("/stats").then(r=>r.json()),fetch("/pool-quality").then(r=>r.json()),fetch("/bots").then(r=>r.json())]);const u=Math.floor(s.uptime/60)+"min";const ab=b.filter(x=>x.secondsSinceLastSeen<30).length;const ib=b.length-ab;let h=\'<div class="grid">\';h+=\'<div class="box"><h3>VITESSE</h3><div class="val">\'+s.jobsPerMinute+\'</div><div class="sub">jobs/minute</div></div>\';h+=\'<div class="box"><h3>HIT RATE</h3><div class="val \'+(parseInt(s.reportsHitRate)>30?"good":"warn")+\'">\'+s.reportsHitRate+\'</div><div class="sub">reports avec brainrot</div></div>\';h+=\'<div class="box"><h3>BOTS ACTIFS</h3><div class="val">\'+ab+\'/\'+b.length+\'</div><div class="sub">idle: \'+ib+\'</div></div>\';h+=\'<div class="box"><h3>POOL SIZE</h3><div class="val good">\'+s.pools.rebirth1plus+\'</div><div class="sub">\'+s.totalScans+\' scans | \'+s.proxies+\' proxies</div></div>\';h+=\'<div class="box"><h3>DISTRIB TOP/RANDOM</h3><div class="val">\'+s.jobsServedTopScore+\' / \'+s.jobsServedRandom+\'</div><div class="sub">\'+Math.round(s.jobsServedTopScore/Math.max(1,s.jobsServed)*100)+\'% top score</div></div>\';h+=\'<div class="box"><h3>BRAINROTS LIVE</h3><div class="val good">\'+s.recentBrainrots+\'</div><div class="sub">actifs TTL 30s</div></div>\';h+=\'</div>\';const q1=q.rebirth1plus;h+=\'<div class="grid"><div class="box"><h3>REBIRTH 1+ - POOL QUALITY</h3>\';h+=\'<div>Pool size: <b>\'+q1.total+\'</b></div>\';h+=\'<div>FPS moyen: <b class="\'+(q1.quality.avgFps>50?"good":"warn")+\'">\'+q1.quality.avgFps+\'</b></div>\';h+=\'<div>Ping moyen: <b class="\'+(q1.quality.avgPing<200?"good":"warn")+\'">\'+q1.quality.avgPing+\'ms</b></div>\';h+=\'<div>Score moyen: <b>\'+q1.quality.avgScore+\'</b></div>\';h+=\'<div>Filtres: <b class="bad">\'+q1.quality.filtered+\'</b> / \'+q1.quality.total+\'</div>\';h+=\'<h3 style="margin-top:10px;">TOP 5 JOBS</h3><table><tr><th>Score</th><th>FPS</th><th>Ping</th><th>Players</th></tr>\';q1.top10.slice(0,5).forEach(x=>{h+=\'<tr><td class="good">\'+x.score+\'</td><td>\'+(x.fps||"N/A")+\'</td><td>\'+(x.ping||"N/A")+\'ms</td><td>\'+x.players+\'/8</td></tr>\';});h+=\'</table></div></div>\';h+=\'<div class="box" style="margin-top:15px;"><h3>TOP 10 BOTS</h3><table><tr><th>Bot</th><th>Jobs</th><th>Last seen</th><th>Status</th></tr>\';const sb=[...b].sort((a,c)=>c.jobsReceived-a.jobsReceived).slice(0,10);sb.forEach(x=>{const st=x.secondsSinceLastSeen<15?\'<span class="good">ACTIVE</span>\':x.secondsSinceLastSeen<60?\'<span class="warn">SLOW</span>\':\'<span class="bad">IDLE</span>\';h+=\'<tr><td>\'+x.name+\'</td><td>\'+x.jobsReceived+\'</td><td>\'+x.secondsSinceLastSeen+\'s</td><td>\'+st+\'</td></tr>\';});h+=\'</table></div>\';document.getElementById("content").innerHTML=h;}refresh();setInterval(refresh,2000);</script></body></html>');
});

// ============================================================
// DASHBOARD BRAINROTS
// ============================================================
app.get('/dashboard', (req, res) => {
    res.send('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Godzilla Notifier</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:SF Mono,Monaco,Inconsolata,Courier New,monospace;background:#000000;color:#00ff00;min-height:100vh;padding:20px;overflow-x:hidden;}.bg-grid{position:fixed;top:0;left:0;width:100%;height:100%;background-image:linear-gradient(rgba(0,255,0,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,0,0.03) 1px,transparent 1px);background-size:50px 50px;z-index:-1;}.container{max-width:1200px;margin:0 auto;position:relative;z-index:1;}.header{text-align:center;margin-bottom:40px;padding:30px;background:#000000;border:3px solid #00ff00;position:relative;overflow:hidden;}.header h1{font-size:48px;color:#00ff00;text-shadow:0 0 10px #00ff00,0 0 20px #00ff00,0 0 30px #00ff00,0 0 40px #00ff00;margin-bottom:10px;letter-spacing:8px;font-weight:900;}.header .subtitle{font-size:14px;color:#00ff00;opacity:0.8;text-transform:uppercase;letter-spacing:4px;font-weight:600;}.stats-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:30px;}.stat-box{background:#000000;border:2px solid #00ff00;padding:15px;text-align:center;}.stat-label{font-size:10px;opacity:0.7;margin-bottom:5px;letter-spacing:2px;}.stat-value{font-size:24px;font-weight:900;color:#00ff00;text-shadow:0 0 10px #00ff00;}.empty{text-align:center;padding:100px 20px;color:#00ff00;font-size:20px;border:3px dashed #00ff00;background:#000000;opacity:0.3;text-transform:uppercase;letter-spacing:3px;}.brainrot-list{display:grid;gap:20px;}.brainrot-card{background:#000000;border:3px solid #00ff00;padding:25px;position:relative;overflow:hidden;box-shadow:0 0 20px rgba(0,255,0,0.3);}.brainrot-card::before{content:"";position:absolute;top:0;left:0;width:6px;height:100%;background:#00ff00;box-shadow:0 0 10px #00ff00;}.top-brainrot::before{background:#ffd700 !important;box-shadow:0 0 15px #ffd700 !important;}.brainrot-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;}.brainrot-left{flex:1;}.brainrot-badges{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}.badge{display:inline-block;padding:6px 12px;background:#00ff00;color:#000000;font-size:11px;font-weight:900;letter-spacing:1.5px;}.badge.top{background:#ffd700;color:#000000;}.top-brainrot{border-color:#ffd700 !important;box-shadow:0 0 30px rgba(255,215,0,0.5) !important;}.brainrot-name{font-size:26px;font-weight:900;color:#ffffff;text-shadow:0 0 15px #00ff00;margin-bottom:8px;line-height:1.2;}.brainrot-value{font-size:42px;font-weight:900;color:#00ff00;text-shadow:0 0 10px #00ff00,0 0 20px #00ff00,0 0 30px #00ff00;letter-spacing:3px;}.brainrot-meta{display:flex;gap:20px;font-size:13px;color:#00ff00;opacity:0.8;margin-bottom:15px;flex-wrap:wrap;}.brainrot-footer{display:flex;gap:12px;align-items:center;}.btn-join{background:#00ff00;color:#000000;border:none;padding:12px 30px;font-size:16px;font-weight:900;cursor:pointer;letter-spacing:2px;font-family:inherit;box-shadow:0 0 15px rgba(0,255,0,0.5);}.btn-join:hover{transform:scale(1.05);box-shadow:0 0 30px rgba(0,255,0,0.8);}.brainrot-timer{background:#000000;border:2px solid #00ff00;padding:8px 16px;font-size:18px;font-weight:900;min-width:70px;text-align:center;}.timer-fresh{color:#00ff00;}.timer-medium{color:#ffaa00;}.timer-expiring{color:#ff5555;}.brainrot-progress{position:absolute;bottom:0;left:0;height:5px;background:#00ff00;}.footer{text-align:center;margin-top:50px;padding:25px;color:#00ff00;font-size:12px;opacity:0.4;border-top:2px solid #00ff00;text-transform:uppercase;letter-spacing:3px;}.copied-toast{position:fixed;top:30px;right:30px;background:#00ff00;color:#000000;padding:20px 30px;font-weight:900;font-size:16px;z-index:9999;border:3px solid #000000;}</style></head><body><div class="bg-grid"></div><div class="container"><div class="header"><h1>GODZILLA NOTIFIER</h1><div class="subtitle">OPTI MAX v6.1 - REBIRTH 1+ ONLY</div></div><div class="stats-bar" id="stats-bar" style="display:none;"><div class="stat-box"><div class="stat-label">TOTAL BRAINROTS</div><div class="stat-value" id="stat-total">0</div></div><div class="stat-box"><div class="stat-label">ACTIFS</div><div class="stat-value" id="stat-active">0</div></div><div class="stat-box"><div class="stat-label">EXPIRANT</div><div class="stat-value" id="stat-expiring">0</div></div></div><div id="brainrots-container"><div class="empty">EN ATTENTE DE BRAINROTS...</div></div><div class="footer">Dev by SALAH | OPTI MAX v6.1 | Live Monitor: /live-monitor</div></div><script>function formatNumeric(n){if(!n||n===0)return"$0/s";const a=Math.abs(n);let f;if(a>=1e12)f="$"+(n/1e12).toFixed(1)+"T/s";else if(a>=1e9)f="$"+(n/1e9).toFixed(1)+"B/s";else if(a>=1e6)f="$"+(n/1e6).toFixed(1)+"M/s";else if(a>=1e3)f="$"+(n/1e3).toFixed(1)+"K/s";else f="$"+n.toFixed(0)+"/s";return f.replace(".0","");}function copyToClipboard(t){navigator.clipboard.writeText(t).then(()=>showToast("JOBID COPIE")).catch(()=>showToast("ERREUR"));}function showToast(m){const e=document.querySelector(".copied-toast");if(e)e.remove();const t=document.createElement("div");t.className="copied-toast";t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),2500);}function updateStats(b){if(!b||b.length===0){document.getElementById("stats-bar").style.display="none";return;}document.getElementById("stats-bar").style.display="grid";document.getElementById("stat-total").textContent=b.length;document.getElementById("stat-active").textContent=b.filter(x=>x.remainingSeconds>=15).length;document.getElementById("stat-expiring").textContent=b.filter(x=>x.remainingSeconds<10).length;}function renderBrainrots(b){const c=document.getElementById("brainrots-container");if(!b||b.length===0){c.innerHTML=\'<div class="empty">EN ATTENTE DE BRAINROTS...</div>\';updateStats(null);return;}updateStats(b);const s=b.sort((x,y)=>y.numeric-x.numeric);const l=document.createElement("div");l.className="brainrot-list";s.forEach((x,i)=>{const r=x.remainingSeconds||0;const tc=r<10?"timer-expiring":r<20?"timer-medium":"timer-fresh";const pw=(r/30)*100;const cd=document.createElement("div");cd.className="brainrot-card";if(i===0)cd.classList.add("top-brainrot");cd.dataset.expiresAt=Date.now()+(r*1000);const mt=x.mutation&&x.mutation!=="None"?"["+x.mutation+"] ":"";const st=(x.source==="carpet"?"CARPET":x.source==="plot"?"PLOT":"UNKNOWN").toUpperCase();const pt=(x.players||0)+"/8";const tb=i===0?\'<span class="badge top">TOP</span>\':"";cd.innerHTML=\'<div class="brainrot-header"><div class="brainrot-left"><div class="brainrot-badges">\'+tb+\'<span class="badge">\'+st+\'</span><span class="badge">\'+pt+\'</span></div><div class="brainrot-name">\'+mt+x.name+\'</div></div><div class="brainrot-value">\'+formatNumeric(x.numeric)+\'</div></div><div class="brainrot-meta"><span>BOT: \'+x.botName+\'</span><span>JOB: \'+x.jobId.substring(0,16)+\'...</span></div><div class="brainrot-footer"><button class="btn-join" onclick="copyToClipboard(\\\'\'+x.jobId+\'\\\')">JOIN</button><div class="brainrot-timer \'+tc+\'">\'+r+\'s</div></div><div class="brainrot-progress" style="width:\'+pw+\'%"></div>\';l.appendChild(cd);});c.innerHTML="";c.appendChild(l);}function fetchBrainrots(){fetch("/api/brainrots").then(r=>r.json()).then(d=>renderBrainrots(d)).catch(e=>console.error(e));}setInterval(()=>{document.querySelectorAll(".brainrot-card").forEach(c=>{const e=parseInt(c.dataset.expiresAt);if(!e)return;const r=Math.max(0,Math.ceil((e-Date.now())/1000));const te=c.querySelector(".brainrot-timer");const pe=c.querySelector(".brainrot-progress");if(te){te.textContent=r+"s";te.className="brainrot-timer "+(r<10?"timer-expiring":r<20?"timer-medium":"timer-fresh");}if(pe)pe.style.width=((r/30)*100)+"%";if(r<=0){c.style.opacity="0";c.style.transform="translateX(-20px)";setTimeout(()=>c.remove(),300);}});},1000);fetchBrainrots();setInterval(fetchBrainrots,1000);</script></body></html>');
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    loadProxies();  // ← charge proxies.txt au démarrage

    console.log('================================================');
    console.log('GODZILLA NOTIFIER BACKEND v6.1 OPTI MAX FINAL');
    console.log('Pool: REBIRTH 1+ UNIQUEMENT');
    console.log('Mode: FRESH pool toutes les ' + SCAN_INTERVAL + 'ms');
    console.log('Pages: ' + MAX_PAGES + ' pages max par scan');
    console.log('Proxies: Promise.any() — le plus rapide gagne');
    console.log('================================================');
    console.log('Port: ' + PORT);
    console.log('Players: ' + MIN_PLAYERS + '-' + MAX_PLAYERS);
    console.log('FILTERING: FPS>=' + MIN_FPS + ' Ping<=' + MAX_PING);
    console.log('TOP_RATIO: ' + (TOP_DISTRIBUTION_RATIO * 100) + '%');
    console.log('================================================');

    scanLoop();
});
