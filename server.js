// Godzilla Notifier Backend - v8.1 + Discord Webhooks + Dashboard v9
// Base = v5.0 (cascade fallback proxies, qui marchait sans 429)
// + Scoring FPS/Ping + dashboard ameliore + DISCORD ALERTS
// v8.1 : liste de bots COMPLETE (plus de limite a 15)
// v9 : Dashboard v9.0 Enhanced — Bot Line Size + Timer System
// By SALAH

const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';
const PLACE_ID = 109983668079237;

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 7;
const SCAN_INTERVAL = 5000;
const MAX_PAGES = 3;
const JOBID_LOCK_TTL = 90 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const BRAINROT_TTL = 30 * 1000;
const MIN_BRAINROT_VALUE = 1000000;
const MAX_LOGS = 200;
const FILTERING_ENABLED = true;
const MIN_FPS = 35;
const MAX_PING = 500;
const TOP_DISTRIBUTION_RATIO = 0.7;

// DISCORD WEBHOOKS
const DISCORD_WEBHOOK_HIGH = 'https://canary.discord.com/api/webhooks/1507761205538984078/nTwxZcOLQT9oruC14PMyt8rQ48xlE4mutp2A6FPh01hZtEePvAp7cMZGo-HKftBhkBCF'; // 100M+
const DISCORD_WEBHOOK_LOW = 'https://canary.discord.com/api/webhooks/1510346972656046341/GLNbbYoVrw8DD_VbmruLgm_jwgGZ_LJlDzpB2C1RQlQiuNIO0sblEp2rHfJvry5KPJau'; // < 100M
const DISCORD_THRESHOLD = 100000000; // 100M
const IMAGE_CACHE = new Map(); // Cache les images pendant 1h
const IMAGE_CACHE_TTL = 3600000;

// CASCADE FALLBACK — essaie chaque proxy dans l'ordre
const PROXIES = [
    'https://calm-glade-1ffa.jedab27255.workers.dev',
    'https://roblox-proxy.salahelarabi03.workers.dev',
    'https://games.roproxy.com',
    'https://games.roblox.com'
];

let pool = [];
let poolQualityStats = { avgFps: 0, avgPing: 0, avgScore: 0, filtered: 0, total: 0 };

const jobLocks = new Map();
const botHistory = new Map();
const reports = new Map();
const recentBrainrots = [];
const liveLogs = [];

const stats = {
    totalScans: 0, jobsServed: 0, jobsServedTopScore: 0, jobsServedRandom: 0,
    reportsReceived: 0, reportsWithBrainrots: 0, logsReceived: 0,
    startedAt: Date.now()
};

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
    if (key !== API_KEY) { res.status(401).json({ error: 'Invalid API key' }); return false; }
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of jobLocks.entries()) { if (v.expiresAt < now) jobLocks.delete(k); }
    for (const [k, v] of botHistory.entries()) { if (now - v.lastSeen > BOT_HISTORY_TTL) botHistory.delete(k); }
    for (let i = recentBrainrots.length - 1; i >= 0; i--) { if (recentBrainrots[i].expiresAt < now) recentBrainrots.splice(i, 1); }
    
    // Nettoie le cache d'images
    for (const [k, v] of IMAGE_CACHE.entries()) {
        if (now - v.cachedAt > IMAGE_CACHE_TTL) IMAGE_CACHE.delete(k);
    }
}, 5000);

// ============================================================
// FETCH IMAGE FROM FANDOM API
// ============================================================

async function getImageUrl(name) {
    try {
        // Vérifie le cache
        if (IMAGE_CACHE.has(name)) {
            const cached = IMAGE_CACHE.get(name);
            return cached.url;
        }

        // Essaie plusieurs variantes du nom
        const variants = [
            name.replace(/ /g, '').replace(/[^\w-]/g, ''), // Sans espaces ni caractères spéciaux
            name.replace(/[^\w\s-]/g, '').trim(), // Garde espaces et tirets
            name.replace(/\[.*?\]\s*/g, '').trim(), // Enlève les [crochets]
            name.split(' ')[0] // Juste le premier mot
        ];

        for (const title of variants) {
            if (!title || title.length < 2) continue;
            
            const apiUrl = `https://stealabrainrot.fandom.com/api.php?action=query&prop=pageimages&format=json&piprop=thumbnail&pithumbsize=500&titles=${encodeURIComponent(title)}`;

            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(apiUrl, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                clearTimeout(timeout);

                if (!response.ok) continue;

                const data = await response.json();
                if (data && data.query && data.query.pages) {
                    for (const pageId in data.query.pages) {
                        const page = data.query.pages[pageId];
                        if (page.thumbnail && page.thumbnail.source) {
                            const imageUrl = page.thumbnail.source;
                            // Cache l'image
                            IMAGE_CACHE.set(name, { url: imageUrl, cachedAt: Date.now() });
                            console.log('[IMAGE] ✅ Found:', title, '->', imageUrl.substring(0, 80) + '...');
                            return imageUrl;
                        }
                    }
                }
            } catch (e) {
                // Essaie la variante suivante
                continue;
            }
        }
        
        console.log('[IMAGE] ⚠️ No image found for:', name);
        return null;
    } catch (e) {
        console.error('[IMAGE] Erreur fetch:', e.message);
        return null;
    }
}

// ============================================================
// SEND DISCORD ALERT
// ============================================================

async function sendDiscordAlert(brainrot) {
    try {
        const isHighValue = brainrot.numeric >= DISCORD_THRESHOLD;
        const webhook = isHighValue ? DISCORD_WEBHOOK_HIGH : DISCORD_WEBHOOK_LOW;
        const imageUrl = await getImageUrl(brainrot.name);

        const sourceEmoji = brainrot.source === 'plot' ? '🏰' : brainrot.source === 'carpet' ? '🧞' : '✨';
        const mutationText = brainrot.mutation && brainrot.mutation !== 'None' ? ` • [${brainrot.mutation}]` : '';
        
        const embed = {
            author: {
                name: '⭐ GODZILLA DETECTED',
                icon_url: 'https://cdn.discordapp.com/avatars/1510343157689565184/a_94c6c0c4b3c1a0d0a1b2c3d4e5f6g7h.gif'
            },
            title: brainrot.name + mutationText,
            description: `**$${(brainrot.numeric / 1e6).toFixed(1)}M/s**`,
            color: isHighValue ? 16711680 : 12745742, // Red pour 100M+, Gold sinon
            image: imageUrl ? { url: imageUrl, height: 400, width: 400 } : undefined,
            fields: [
                {
                    name: '━━━━━━━━━━━━━━━━━━━━━',
                    value: ' ',
                    inline: false
                },
                {
                    name: sourceEmoji + ' Location',
                    value: brainrot.source === 'plot' ? 'Plot' : brainrot.source === 'carpet' ? 'Carpet' : 'Unknown',
                    inline: true
                },
                {
                    name: '👥 Players',
                    value: `${brainrot.players || 0}/8`,
                    inline: true
                },
                {
                    name: isHighValue ? '🔥 PREMIUM' : '💎 Standard',
                    value: isHighValue ? 'High Value' : 'Regular',
                    inline: true
                }
            ],
            footer: {
                text: 'Godzilla Notifier',
                icon_url: 'https://cdn.discordapp.com/avatars/1510343157689565184/a_94c6c0c4b3c1a0d0a1b2c3d4e5f6g7h.gif'
            },
            timestamp: new Date().toISOString()
        };

        const payload = {
            username: 'Godzilla Alerte',
            avatar_url: 'https://cdn.discordapp.com/avatars/1510343157689565184/a_94c6c0c4b3c1a0d0a1b2c3d4e5f6g7h.gif',
            content: isHighValue ? `🔥 **ALERTE 100M+** 🔥\n${brainrot.name} - $${(brainrot.numeric / 1e6).toFixed(1)}M/s` : null,
            embeds: [embed]
        };

        const response = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error('[DISCORD] HTTP Error:', response.status, response.statusText);
        } else {
            console.log('[DISCORD] Alert sent:', brainrot.name, `($${(brainrot.numeric / 1e6).toFixed(1)}M)`, isHighValue ? '🔥 HIGH' : '💎 LOW');
        }
    } catch (e) {
        console.error('[DISCORD] Erreur:', e.message);
        // Continue malgré l'erreur - ne pas casser le service
    }
}

// ============================================================
// FETCH — Cascade fallback (proven anti-429)
// ============================================================

async function fetchServers(cursor) {
    const path = '/v1/games/' + PLACE_ID + '/servers/Public?limit=100&excludeFullGames=true' + (cursor ? '&cursor=' + cursor : '');

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
        } catch (e) {
            // Try next proxy
        }
    }

    return null;
}

// ============================================================
// SCAN — 1 seul scan loop, fresh pool a chaque cycle
// ============================================================

async function scanPool() {
    const newPool = [];
    let cursor = '';
    let totalScanned = 0, filteredOut = 0, sumFps = 0, sumPing = 0, sumScore = 0, pagesScanned = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await fetchServers(cursor);
        if (!data || !data.data) break;
        pagesScanned++;

        for (const server of data.data) {
            if (server.playing >= MIN_PLAYERS && server.playing <= MAX_PLAYERS) {
                totalScanned++;
                if (FILTERING_ENABLED) {
                    if (server.fps !== undefined && server.fps < MIN_FPS) { filteredOut++; continue; }
                    if (server.ping !== undefined && server.ping > MAX_PING) { filteredOut++; continue; }
                }
                const s = { jobId: server.id, players: server.playing, maxPlayers: server.maxPlayers, fps: server.fps, ping: server.ping };
                s.score = calculateServerScore(s);
                newPool.push(s);
                if (server.fps) sumFps += server.fps;
                if (server.ping) sumPing += server.ping;
                sumScore += s.score;
            }
        }
        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
        await new Promise(r => setTimeout(r, 200));
    }

    if (pagesScanned === 0) {
        console.log('[SCAN] Tous les proxies dead, pool conserve (' + pool.length + ' serveurs)');
        return;
    }

    newPool.sort((a, b) => b.score - a.score);
    pool = newPool;

    if (newPool.length > 0) {
        poolQualityStats = {
            avgFps: Math.round((sumFps / newPool.length) * 10) / 10,
            avgPing: Math.round(sumPing / newPool.length),
            avgScore: Math.round(sumScore / newPool.length),
            filtered: filteredOut, total: totalScanned
        };
    }

    stats.totalScans++;
    console.log('[SCAN] ' + newPool.length + ' serveurs | Pages: ' + pagesScanned + ' | Filtres: ' + filteredOut + ' | Top score: ' + (newPool[0] ? newPool[0].score : 0));
}

async function scanLoop() {
    while (true) {
        try { await scanPool(); } catch (e) { console.error('[SCAN] Erreur:', e.message); }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
}

// ============================================================
// API ENDPOINTS
// ============================================================

app.get('/', (req, res) => res.json({
    name: 'Godzilla Notifier', version: '8.1 + Discord + Dashboard v9',
    pool: pool.length,
    config: { scanInterval: SCAN_INTERVAL + 'ms', maxPages: MAX_PAGES, proxies: PROXIES.length }
}));

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Math.floor((Date.now() - stats.startedAt) / 1000), pool: pool.length }));

app.get('/jobs', (req, res) => {
    if (!checkAuth(req, res)) return;
    const username = req.headers.username || 'anonymous';
    if (!pool || pool.length === 0) return res.status(503).send('Pool empty');

    if (!botHistory.has(username)) {
        botHistory.set(username, { firstSeen: Date.now(), lastSeen: Date.now(), jobsReceived: 0, currentJobId: null, visitedJobs: new Set() });
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

    if (candidates.length === 0) { botData.visitedJobs = new Set(); return res.status(503).send('All visited'); }

    let selected;
    const useTopScore = Math.random() < TOP_DISTRIBUTION_RATIO;
    if (useTopScore) {
        const topSize = Math.max(1, Math.floor(candidates.length * 0.3));
        selected = candidates.slice(0, topSize)[Math.floor(Math.random() * topSize)];
        stats.jobsServedTopScore++;
    } else {
        selected = candidates[Math.floor(Math.random() * candidates.length)];
        stats.jobsServedRandom++;
    }

    // Retire du pool pour ne plus le redistribuer
    const idx = pool.findIndex(s => s.jobId === selected.jobId);
    if (idx !== -1) pool.splice(idx, 1);

    jobLocks.set(selected.jobId, { botName: username, expiresAt: now + JOBID_LOCK_TTL });
    botData.currentJobId = selected.jobId;
    botData.visitedJobs.add(selected.jobId);
    stats.jobsServed++;

    console.log('[JOBS] ' + username + ' -> ' + selected.jobId.substring(0, 12) + '... Score:' + selected.score + ' (' + (useTopScore ? 'TOP' : 'RND') + ') Pool reste: ' + pool.length);
    res.send(selected.jobId);
});

app.post('/report-data', (req, res) => {
    if (!checkAuth(req, res)) return;
    const { botName, jobId, name, money, numeric = 0, mutation, brainrots, source, players } = req.body || {};
    if (!botName || !jobId) return res.status(400).json({ error: 'Missing botName or jobId' });
    stats.reportsReceived++;
    reports.set(botName + ':' + jobId, { botName, jobId, name, money, numeric, mutation, brainrots, source, players, timestamp: Date.now() });
    let hasValid = false;
    if (Array.isArray(brainrots) && brainrots.length > 0) {
        const now = Date.now();
        for (const item of brainrots) {
            if (item.numeric >= MIN_BRAINROT_VALUE && item.name) {
                hasValid = true;
                const dup = recentBrainrots.some(e => e.name === item.name && e.numeric === item.numeric && e.jobId === jobId && e.expiresAt > now);
                if (!dup) {
                    const newBrainrot = { botName, jobId, name: item.name, money: item.money, numeric: item.numeric, mutation: item.mutation || null, source: item.source || 'unknown', players: players || 0, receivedAt: now, expiresAt: now + BRAINROT_TTL };
                    recentBrainrots.unshift(newBrainrot);
                    
                    // 🔥 ENVOIE L'ALERTE DISCORD (async, non-blocking)
                    sendDiscordAlert(newBrainrot).catch(e => console.error('[DISCORD] Failed:', e));
                }
            }
        }
    }
    if (hasValid) stats.reportsWithBrainrots++;
    res.json({ success: true });
});

app.post('/log', (req, res) => {
    if (!checkAuth(req, res)) return;
    const { botName = 'unknown', message = '' } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Missing message' });
    stats.logsReceived++;
    liveLogs.unshift({ botName, message, timestamp: Date.now() });
    if (liveLogs.length > MAX_LOGS) liveLogs.length = MAX_LOGS;
    res.json({ success: true });
});

app.get('/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    const m = uptime / 60;
    res.json({
        uptime, pool: pool.length,
        totalScans: stats.totalScans,
        jobsServed: stats.jobsServed, jobsServedTopScore: stats.jobsServedTopScore, jobsServedRandom: stats.jobsServedRandom,
        jobsPerMinute: m > 0 ? Math.round(stats.jobsServed / m) : 0,
        reportsReceived: stats.reportsReceived, reportsWithBrainrots: stats.reportsWithBrainrots,
        reportsHitRate: stats.reportsReceived > 0 ? Math.round((stats.reportsWithBrainrots / stats.reportsReceived) * 100) + '%' : '0%',
        activeBots: botHistory.size, recentBrainrots: recentBrainrots.length,
        quality: poolQualityStats
    });
});

app.get('/pool', (req, res) => res.json({ count: pool.length, quality: poolQualityStats, servers: pool.slice(0, 50) }));

app.get('/bots', (req, res) => {
    const now = Date.now();
    const bots = [];
    for (const [name, data] of botHistory.entries()) {
        bots.push({ name, secondsSinceLastSeen: Math.floor((now - data.lastSeen) / 1000), jobsReceived: data.jobsReceived, currentJobId: data.currentJobId });
    }
    res.json(bots.sort((a, b) => a.secondsSinceLastSeen - b.secondsSinceLastSeen));
});

app.get('/api/brainrots', (req, res) => {
    const now = Date.now();
    res.json(recentBrainrots.filter(b => b.expiresAt > now).map(b => ({
        botName: b.botName, jobId: b.jobId, name: b.name, money: b.money, numeric: b.numeric,
        mutation: b.mutation, source: b.source || 'unknown', players: b.players || 0,
        remainingSeconds: Math.ceil((b.expiresAt - now) / 1000)
    })));
});

app.get('/live-monitor', (req, res) => {
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Live Monitor</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Courier New,monospace;background:#0a0a0a;color:#00ff00;padding:20px}h1{text-align:center;margin-bottom:20px;text-shadow:0 0 10px #00ff00}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:15px;margin-bottom:20px}.box{background:#111;border:1px solid #00ff00;padding:15px}.box h3{color:#ffff00;margin-bottom:10px;font-size:13px}.val{font-size:32px;font-weight:bold}.sub{font-size:11px;opacity:.7;margin-top:5px}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:11px}th,td{padding:4px 8px;text-align:left;border-bottom:1px solid #002200}th{background:#001100;color:#ffff00}.good{color:#00ff00}.bad{color:#f00}.warn{color:#fa0}.refresh{text-align:center;opacity:.5;font-size:10px;margin-top:20px}</style></head><body><h1>GODZILLA v8.1 + DISCORD LIVE</h1><div id="c">Loading...</div><div class="refresh">Auto-refresh 2s</div><script>async function r(){const[s,b]=await Promise.all([fetch("/stats").then(x=>x.json()),fetch("/bots").then(x=>x.json())]);const u=Math.floor(s.uptime/60)+"min";const ab=b.filter(x=>x.secondsSinceLastSeen<30).length;let h=\'<div class="grid">\';h+=\'<div class="box"><h3>POOL</h3><div class="val good">\'+s.pool+\'</div><div class="sub">\'+s.totalScans+\' scans</div></div>\';h+=\'<div class="box"><h3>JOBS/MIN</h3><div class="val">\'+s.jobsPerMinute+\'</div><div class="sub">\'+s.jobsServed+\' servis</div></div>\';h+=\'<div class="box"><h3>HIT RATE</h3><div class="val \'+(parseInt(s.reportsHitRate)>30?"good":"warn")+\'">\'+s.reportsHitRate+\'</div><div class="sub">\'+s.reportsReceived+\' reports</div></div>\';h+=\'<div class="box"><h3>BOTS</h3><div class="val">\'+ab+\'/\'+b.length+\'</div><div class="sub">uptime: \'+u+\'</div></div>\';h+=\'<div class="box"><h3>QUALITE POOL</h3><div class="val">\'+s.quality.avgScore+\'</div><div class="sub">FPS:\'+s.quality.avgFps+\' Ping:\'+s.quality.avgPing+\'ms</div></div>\';h+=\'<div class="box"><h3>BRAINROTS LIVE</h3><div class="val good">\'+s.recentBrainrots+\'</div><div class="sub">TTL 30s</div></div>\';h+=\'</div>\';h+=\'<div class="box"><h3>BOTS DETAIL (\'+b.length+\')</h3><table><tr><th>Nom</th><th>Jobs</th><th>Vu il y a</th><th>Status</th></tr>\';b.forEach(x=>{const st=x.secondsSinceLastSeen<15?\'<span class="good">ACTIVE</span>\':x.secondsSinceLastSeen<60?\'<span class="warn">SLOW</span>\':\'<span class="bad">IDLE</span>\';h+=\'<tr><td>\'+x.name+\'</td><td>\'+x.jobsReceived+\'</td><td>\'+x.secondsSinceLastSeen+\'s</td><td>\'+st+\'</td></tr>\';});h+=\'</table></div>\';document.getElementById("c").innerHTML=h;}r();setInterval(r,2000);</script></body></html>');
});

app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Godzilla Notifier v9 - Enhanced Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Courier New', monospace;
            background: #000;
            color: #00ff00;
            min-height: 100vh;
            padding: 20px;
            overflow-x: hidden;
        }
        
        .bg {
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background-image: 
                linear-gradient(rgba(0,255,0,.02) 1px, transparent 1px),
                linear-gradient(90deg, rgba(0,255,0,.02) 1px, transparent 1px);
            background-size: 40px 40px;
            z-index: -1;
        }
        
        .container { max-width: 1400px; margin: 0 auto; }
        
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 25px;
            border: 3px solid #00ff00;
            background: rgba(0, 255, 0, 0.05);
            box-shadow: 0 0 20px rgba(0,255,0,0.2);
        }
        
        .header h1 {
            font-size: 52px;
            text-shadow: 0 0 20px #00ff00;
            letter-spacing: 6px;
            font-weight: 900;
            margin-bottom: 10px;
        }
        
        .subtitle {
            font-size: 12px;
            opacity: .7;
            text-transform: uppercase;
            letter-spacing: 3px;
        }
        
        .toolbar {
            display: flex;
            gap: 15px;
            justify-content: center;
            align-items: center;
            margin-bottom: 25px;
            flex-wrap: wrap;
        }
        
        .btn-group {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        
        .btn {
            background: #00ff00;
            color: #000;
            border: 2px solid #00ff00;
            padding: 12px 25px;
            font-size: 13px;
            font-weight: 900;
            cursor: pointer;
            font-family: inherit;
            text-transform: uppercase;
            letter-spacing: 2px;
            transition: all 0.2s;
            min-width: 120px;
        }
        
        .btn:hover {
            background: #000;
            color: #00ff00;
            box-shadow: 0 0 15px rgba(0,255,0,0.6);
            transform: scale(1.05);
        }
        
        .btn-clear {
            background: #ff4444;
            border-color: #ff4444;
            min-width: 150px;
        }
        
        .btn-clear:hover {
            background: #000;
            color: #ff4444;
            box-shadow: 0 0 15px rgba(255,68,68,0.6);
        }
        
        .slider-group {
            display: flex;
            align-items: center;
            gap: 10px;
            background: rgba(0,255,0,0.1);
            padding: 8px 15px;
            border: 2px solid #00ff00;
            border-radius: 4px;
        }
        
        .slider-group label {
            font-size: 11px;
            white-space: nowrap;
            font-weight: 900;
        }
        
        input[type="range"] {
            width: 150px;
            accent-color: #00ff00;
        }
        
        .size-display {
            font-size: 13px;
            font-weight: 900;
            color: #ffff00;
            min-width: 50px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }
        
        .stat-box {
            background: rgba(0,255,0,0.05);
            border: 2px solid #00ff00;
            padding: 15px;
            text-align: center;
        }
        
        .stat-label {
            font-size: 11px;
            opacity: .7;
            text-transform: uppercase;
            margin-bottom: 5px;
        }
        
        .stat-value {
            font-size: 36px;
            font-weight: 900;
            color: #ffff00;
            text-shadow: 0 0 10px #ffff00;
        }
        
        .empty {
            text-align: center;
            padding: 80px 20px;
            font-size: 18px;
            border: 3px dashed #00ff00;
            opacity: .4;
            text-transform: uppercase;
            letter-spacing: 2px;
            margin: 40px 0;
        }
        
        .list {
            display: grid;
            gap: 15px;
            margin-bottom: 30px;
        }
        
        .card {
            background: #000;
            border: 2px solid #00ff00;
            padding: 20px;
            position: relative;
            overflow: hidden;
            box-shadow: 0 0 15px rgba(0,255,0,0.2);
            transition: all 0.3s;
            min-height: 140px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
        }
        
        .card.top-card {
            border: 3px solid #ffd700;
            background: rgba(255, 215, 0, 0.08);
            box-shadow: 0 0 25px rgba(255,215,0,0.4), inset 0 0 20px rgba(255,215,0,0.1);
        }
        
        .card:hover {
            transform: translateY(-3px);
            box-shadow: 0 0 25px rgba(0,255,0,0.4);
        }
        
        .card.top-card:hover {
            box-shadow: 0 0 30px rgba(255,215,0,0.6), inset 0 0 20px rgba(255,215,0,0.1);
        }
        
        .bot-name {
            font-size: 32px;
            font-weight: 900;
            color: #fff;
            text-shadow: 0 0 10px rgba(0,255,0,0.3);
            margin-bottom: 12px;
            letter-spacing: 1px;
            text-transform: uppercase;
        }
        
        .card.top-card .bot-name {
            color: #ffd700;
            text-shadow: 0 0 15px rgba(255,215,0,0.6);
        }
        
        .bot-value {
            font-size: 48px;
            font-weight: 900;
            color: #00ff00;
            text-shadow: 0 0 15px #00ff00;
            margin-bottom: 10px;
        }
        
        .card.top-card .bot-value {
            color: #ffd700;
            text-shadow: 0 0 20px #ffd700;
        }
        
        .bot-meta {
            display: flex;
            gap: 15px;
            font-size: 13px;
            opacity: .8;
            margin-bottom: 12px;
            flex-wrap: wrap;
        }
        
        .meta-item {
            background: rgba(0,255,0,0.1);
            padding: 5px 12px;
            border-radius: 3px;
            white-space: nowrap;
        }
        
        .card.top-card .meta-item {
            background: rgba(255,215,0,0.15);
        }
        
        .badges {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
            flex-wrap: wrap;
        }
        
        .badge {
            display: inline-block;
            padding: 6px 12px;
            background: #00ff00;
            color: #000;
            font-size: 12px;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .badge.gold {
            background: #ffd700;
        }
        
        .badge.mut {
            background: #00ddff;
        }
        
        .card-footer {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-top: 12px;
        }
        
        .card-btn {
            background: #00ff00;
            color: #000;
            border: none;
            padding: 10px 20px;
            font-size: 12px;
            font-weight: 900;
            cursor: pointer;
            font-family: inherit;
            text-transform: uppercase;
            transition: all 0.2s;
            flex: 1;
        }
        
        .card-btn:hover {
            background: #ffff00;
            box-shadow: 0 0 10px rgba(255,255,0,0.5);
        }
        
        .timer {
            border: 2px solid #00ff00;
            padding: 8px 15px;
            font-size: 20px;
            font-weight: 900;
            min-width: 80px;
            text-align: center;
            background: rgba(0,255,0,0.1);
        }
        
        .timer.warn {
            border-color: #fa0;
            color: #fa0;
            background: rgba(250,165,0,0.1);
        }
        
        .timer.critical {
            border-color: #f55;
            color: #f55;
            background: rgba(255,85,85,0.1);
        }
        
        .card.top-card .timer {
            border-color: #ffd700;
            color: #ffd700;
            background: rgba(255,215,0,0.1);
        }
        
        .prog {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 4px;
            background: #00ff00;
            transition: width 0.1s linear;
        }
        
        .card.top-card .prog {
            background: #ffd700;
        }
        
        .footer {
            text-align: center;
            padding: 20px;
            opacity: .4;
            font-size: 11px;
            border-top: 1px solid #00ff00;
            text-transform: uppercase;
            margin-top: 40px;
        }
        
        @media (max-width: 768px) {
            .header h1 { font-size: 36px; }
            .bot-name { font-size: 24px; }
            .bot-value { font-size: 36px; }
            .toolbar { flex-direction: column; }
            .btn, .btn-clear { width: 100%; }
            .slider-group { width: 100%; }
        }
    </style>
</head>
<body>
    <div class="bg"></div>
    <div class="container">
        <div class="header">
            <h1>🔥 GODZILLA NOTIFIER 🔥</h1>
            <div class="subtitle">v9.0 Enhanced — Discord Alerts + Live Dashboard</div>
        </div>
        
        <div class="toolbar">
            <div class="btn-group">
                <button class="btn" onclick="refreshData()">🔄 REFRESH</button>
                <button class="btn btn-clear" onclick="clearAll()">❌ CLEAR ALL BOTS</button>
            </div>
            <div class="slider-group">
                <label for="sizeSlider">📏 Bot Line Size:</label>
                <input type="range" id="sizeSlider" min="1" max="2.5" step="0.1" value="1" oninput="updateSize()">
                <div class="size-display" id="sizeDisplay">1.0x</div>
            </div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-box">
                <div class="stat-label">Brainrots Live</div>
                <div class="stat-value" id="stat-count">0</div>
            </div>
            <div class="stat-box">
                <div class="stat-label">Highest Value</div>
                <div class="stat-value" id="stat-highest">$0</div>
            </div>
            <div class="stat-box">
                <div class="stat-label">Average TTL</div>
                <div class="stat-value" id="stat-ttl">0s</div>
            </div>
            <div class="stat-box">
                <div class="stat-label">Last Update</div>
                <div class="stat-value" id="stat-update">--:--</div>
            </div>
        </div>
        
        <div id="app">
            <div class="empty">⏳ AWAITING BRAINROTS...</div>
        </div>
        
        <div class="footer">
            Dev by SALAH | Godzilla v8.1+ | Auto-refresh 1s | /live-monitor | /stats
        </div>
    </div>
    
    <script>
        let allBrainrots = [];
        let sizeMultiplier = 1;
        
        function fmt(n) {
            if (!n) return "$0/s";
            const a = Math.abs(n);
            if (a >= 1e12) return "$" + (n/1e12).toFixed(1).replace(".0","") + "T/s";
            if (a >= 1e9) return "$" + (n/1e9).toFixed(1).replace(".0","") + "B/s";
            if (a >= 1e6) return "$" + (n/1e6).toFixed(1).replace(".0","") + "M/s";
            return "$" + (n/1e3).toFixed(1).replace(".0","") + "K/s";
        }
        
        function copy(t) {
            navigator.clipboard.writeText(t).then(() => {
                const d = document.createElement("div");
                d.style = "position:fixed;top:20px;right:20px;background:#00ff00;color:#000;padding:15px 25px;font-weight:900;z-index:9999;border:2px solid #000;font-size:14px;";
                d.textContent = "✅ COPIED!";
                document.body.appendChild(d);
                setTimeout(() => d.remove(), 2000);
            });
        }
        
        function removeBrainrot(index) {
            allBrainrots.splice(index, 1);
            render(allBrainrots);
        }
        
        function clearAll() {
            if (confirm('⚠️ Clear ALL brainrots? (Cannot undo)')) {
                allBrainrots = [];
                render([]);
            }
        }
        
        function updateSize() {
            sizeMultiplier = parseFloat(document.getElementById('sizeSlider').value);
            document.getElementById('sizeDisplay').textContent = sizeMultiplier.toFixed(1) + 'x';
            document.querySelectorAll('.card').forEach(card => {
                card.style.minHeight = (140 * sizeMultiplier) + 'px';
                card.style.padding = (20 * sizeMultiplier) + 'px';
            });
            document.querySelectorAll('.bot-name').forEach(el => {
                el.style.fontSize = (32 * sizeMultiplier) + 'px';
            });
            document.querySelectorAll('.bot-value').forEach(el => {
                el.style.fontSize = (48 * sizeMultiplier) + 'px';
            });
            document.querySelectorAll('.bot-meta').forEach(el => {
                el.style.fontSize = (13 * sizeMultiplier) + 'px';
            });
            document.querySelectorAll('.timer').forEach(el => {
                el.style.fontSize = (20 * sizeMultiplier) + 'px';
            });
        }
        
        async function refreshData() {
            try {
                const resp = await fetch("/api/brainrots");
                if (resp.ok) {
                    allBrainrots = await resp.json();
                    render(allBrainrots);
                }
            } catch (e) {
                console.error("Fetch error:", e);
            }
        }
        
        function render(b) {
            const c = document.getElementById("app");
            
            if (!b || b.length === 0) {
                c.innerHTML = '<div class="empty">⏳ AWAITING BRAINROTS...</div>';
                updateStats(b);
                return;
            }
            
            b.sort((x, y) => y.numeric - x.numeric);
            
            const l = document.createElement("div");
            l.className = "list";
            
            b.forEach((x, i) => {
                const d = document.createElement("div");
                d.className = "card" + (i === 0 ? " top-card" : "");
                d.dataset.startTime = Date.now();
                d.style.minHeight = (140 * sizeMultiplier) + 'px';
                d.style.padding = (20 * sizeMultiplier) + 'px';
                
                const src = x.source === "carpet" ? "CARPET" : x.source === "plot" ? "PLOT" : "?";
                const mut = x.mutation && x.mutation !== "None" ? x.mutation : null;
                
                const badgesHtml = \`
                    \${i === 0 ? '<span class="badge gold">🏆 TOP</span>' : ''}
                    <span class="badge">\${src}</span>
                    <span class="badge">\${x.players}/8</span>
                    \${mut ? \`<span class="badge mut">[\${mut}]</span>\` : ''}
                \`;
                
                d.innerHTML = \`
                    <div>
                        <div class="badges">\${badgesHtml}</div>
                        <div class="bot-name" style="font-size: \${32 * sizeMultiplier}px;">\${x.name}</div>
                        <div class="bot-value" style="font-size: \${48 * sizeMultiplier}px;">\${fmt(x.numeric)}</div>
                    </div>
                    <div class="bot-meta" style="font-size: \${13 * sizeMultiplier}px;">
                        <div class="meta-item">🤖 \${x.botName}</div>
                        <div class="meta-item">📍 \${x.jobId.substring(0, 20)}...</div>
                    </div>
                    <div class="card-footer">
                        <button class="card-btn" onclick="copy('\${x.jobId}')">📋 COPY ID</button>
                        <button class="card-btn" onclick="copy('\${x.jobId.substring(0, 12)}')")>📌 SHORT</button>
                        <div class="timer" style="font-size: \${20 * sizeMultiplier}px;">0s</div>
                        <button class="card-btn" onclick="removeBrainrot(\${i})">❌</button>
                    </div>
                    <div class="prog" style="width: 100%;"></div>
                \`;
                
                l.appendChild(d);
            });
            
            c.innerHTML = "";
            c.appendChild(l);
            updateStats(b);
        }
        
        function updateStats(b) {
            document.getElementById('stat-count').textContent = b ? b.length : '0';
            
            if (b && b.length > 0) {
                const highest = b[0].numeric;
                document.getElementById('stat-highest').textContent = fmt(highest);
                
                const avgTtl = Math.round(b.reduce((a, x) => a + (x.remainingSeconds || 0), 0) / b.length);
                document.getElementById('stat-ttl').textContent = avgTtl + 's';
            } else {
                document.getElementById('stat-highest').textContent = '$0';
                document.getElementById('stat-ttl').textContent = '0s';
            }
            
            const now = new Date();
            document.getElementById('stat-update').textContent = 
                String(now.getHours()).padStart(2, '0') + ':' +
                String(now.getMinutes()).padStart(2, '0');
        }
        
        refreshData();
        setInterval(refreshData, 1000);
        
        setInterval(() => {
            document.querySelectorAll(".card").forEach((c, idx) => {
                const startTime = parseInt(c.dataset.startTime);
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                
                const te = c.querySelector(".timer");
                const pe = c.querySelector(".prog");
                
                if (te) {
                    te.textContent = elapsed + 's';
                    
                    if (elapsed < 60) {
                        te.className = "timer";
                        te.style.borderColor = "#00ff00";
                        te.style.color = "#00ff00";
                        te.style.background = "rgba(0,255,0,0.1)";
                    } else if (elapsed < 100) {
                        te.className = "timer warn";
                        te.style.borderColor = "#fa0";
                        te.style.color = "#fa0";
                        te.style.background = "rgba(250,165,0,0.1)";
                    } else {
                        te.className = "timer critical";
                        te.style.borderColor = "#f55";
                        te.style.color = "#f55";
                        te.style.background = "rgba(255,85,85,0.1)";
                    }
                }
                
                if (pe) {
                    const progress = Math.min(100, (elapsed / 100) * 100);
                    pe.style.width = progress + "%";
                    
                    if (elapsed < 60) {
                        pe.style.background = "#00ff00";
                    } else if (elapsed < 100) {
                        pe.style.background = "#fa0";
                    } else {
                        pe.style.background = "#f55";
                    }
                }
            });
        }, 500);
    </script>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log('================================================');
    console.log('GODZILLA NOTIFIER v8.1 + DISCORD + DASHBOARD v9');
    console.log('PlaceId: ' + PLACE_ID);
    console.log('Scan: toutes les ' + (SCAN_INTERVAL/1000) + 's | Pages: ' + MAX_PAGES);
    console.log('Proxies cascade:');
    PROXIES.forEach(p => console.log('  - ' + p));
    console.log('Discord Webhooks:');
    console.log('  - 100M+: ' + DISCORD_WEBHOOK_HIGH.substring(0, 60) + '...');
    console.log('  - < 100M: ' + DISCORD_WEBHOOK_LOW.substring(0, 60) + '...');
    console.log('PORT: ' + PORT);
    console.log('================================================');
    scanLoop();
});
