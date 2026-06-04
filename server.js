// Godzilla Notifier Backend - v8.4 SIMPLIFIED
// Base = v5.0 (cascade fallback proxies)
// + 7/8 ONLY FILTER + BLACKLIST 10MIN + POOL RESET + DISCORD BATCHING
// v8.1 : liste de bots COMPLETE
// v8.2 : FIX rate limiting logs + FIX affichage 1000/M + FIX clear bots
// v8.3 : FIX formatMoney() + Discord batching anti-spam
// v8.4 : 7/8 ONLY + Blacklist 10min + Pool reset + No scoring FPS/Ping
// By SALAH

const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';
const PLACE_ID = 109983668079237;

const SCAN_INTERVAL = 100;
const MAX_PAGES = 200;
const BRAINROT_TTL = 30 * 1000;
const MIN_BRAINROT_VALUE = 1000000;
const MAX_LOGS = 200;
const BLACKLIST_TTL = 10 * 60 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;

const LOG_BATCH_SIZE = 50;
const LOG_BATCH_INTERVAL = 5000;
let logBuffer = [];
let logBatchTimer = null;

function flushLogBatch() {
    if (logBuffer.length === 0) return;
    const batch = logBuffer.splice(0, LOG_BATCH_SIZE);
    console.log(`[LOG BATCH] Flushing ${batch.length} logs`);
    batch.forEach(log => {
        liveLogs.unshift(log);
    });
    if (liveLogs.length > MAX_LOGS) liveLogs.length = MAX_LOGS;
    if (logBuffer.length > 0) {
        logBatchTimer = setTimeout(flushLogBatch, LOG_BATCH_INTERVAL);
    }
}

let discordQueue = [];
let discordBatchTimer = null;
const DISCORD_BATCH_SIZE = 3;
const DISCORD_BATCH_INTERVAL = 2000;
const ANTI_SPAM_DELAY = 300;

function formatMoney(n) {
    if (!n || n === 0) return '$0/s';
    const a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T/s';
    if (a >= 1e9)  return '$' + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B/s';
    if (a >= 1e6)  return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M/s';
    if (a >= 1e3)  return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K/s';
    return '$' + Math.round(n) + '/s';
}

async function flushDiscordBatch() {
    if (discordQueue.length === 0) return;
    const batch = discordQueue.splice(0, DISCORD_BATCH_SIZE);
    console.log(`[DISCORD BATCH] Sending ${batch.length} alerts`);
    for (const brainrot of batch) {
        try {
            await sendDiscordAlertSync(brainrot);
            await new Promise(r => setTimeout(r, ANTI_SPAM_DELAY));
        } catch (e) {
            console.error('[DISCORD] Batch error:', e.message);
        }
    }
    if (discordQueue.length > 0) {
        discordBatchTimer = setTimeout(flushDiscordBatch, DISCORD_BATCH_INTERVAL);
    }
}

const DISCORD_WEBHOOK_HIGH = 'https://canary.discord.com/api/webhooks/1507761205538984078/nTwxZcOLQT9oruC14PMyt8rQ48xlE4mutp2A6FPh01hZtEePvAp7cMZGo-HKftBhkBCF';
const DISCORD_WEBHOOK_LOW = 'https://canary.discord.com/api/webhooks/1510346972656046341/GLNbbYoVrw8DD_VbmruLgm_jwgGZ_LJlDzpB2C1RQlQiuNIO0sblEp2rHfJvry5KPJau';
const DISCORD_THRESHOLD = 100000000;
const IMAGE_CACHE = new Map();
const IMAGE_CACHE_TTL = 3600000;

const PROXIES = [
    'https://roblox-proxy.salahelarabi03.workers.dev',
    'https://games.roproxy.com',
    'https://games.roblox.com'
];

let pool = [];
const jobLocks = new Map();
const botHistory = new Map();
const reports = new Map();
const recentBrainrots = [];
const liveLogs = [];

const stats = {
    totalScans: 0, 
    jobsServed: 0,
    reportsReceived: 0, 
    reportsWithBrainrots: 0, 
    logsReceived: 0,
    startedAt: Date.now()
};

const blacklist = new Map();

function cleanupBlacklist() {
    const now = Date.now();
    for (const [jobId, expiresAt] of blacklist.entries()) {
        if (expiresAt < now) {
            blacklist.delete(jobId);
        }
    }
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
    for (const [k, v] of IMAGE_CACHE.entries()) {
        if (now - v.cachedAt > IMAGE_CACHE_TTL) IMAGE_CACHE.delete(k);
    }
    cleanupBlacklist();
}, 5000);

async function getImageUrl(name) {
    try {
        if (IMAGE_CACHE.has(name)) {
            const cached = IMAGE_CACHE.get(name);
            return cached.url;
        }
        const variants = [
            name.replace(/ /g, '').replace(/[^\w-]/g, ''),
            name.replace(/[^\w\s-]/g, '').trim(),
            name.replace(/\[.*?\]\s*/g, '').trim(),
            name.split(' ')[0]
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
                            IMAGE_CACHE.set(name, { url: imageUrl, cachedAt: Date.now() });
                            console.log('[IMAGE] ✅ Found:', title);
                            return imageUrl;
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        console.log('[IMAGE] ⚠️ No image found for:', name);
        return null;
    } catch (e) {
        console.error('[IMAGE] Error:', e.message);
        return null;
    }
}

async function sendDiscordAlertSync(brainrot) {
    try {
        const isHighValue = brainrot.numeric >= DISCORD_THRESHOLD;
        const webhook = isHighValue ? DISCORD_WEBHOOK_HIGH : DISCORD_WEBHOOK_LOW;
        const imageUrl = await getImageUrl(brainrot.name);
        const sourceEmoji = brainrot.source === 'plot' ? '🏰' : brainrot.source === 'carpet' ? '🧞' : '✨';
        const mutationText = brainrot.mutation && brainrot.mutation !== 'None' ? ` • [${brainrot.mutation}]` : '';
        const formattedValue = formatMoney(brainrot.numeric);
        
        const embed = {
            author: {
                name: '⭐ GODZILLA DETECTED',
                icon_url: 'https://cdn.discordapp.com/avatars/1510343157689565184/a_94c6c0c4b3c1a0d0a1b2c3d4e5f6g7h.gif'
            },
            title: brainrot.name + mutationText,
            description: `**${formattedValue}**`,
            color: isHighValue ? 16711680 : 12745742,
            image: imageUrl ? { url: imageUrl, height: 400, width: 400 } : undefined,
            fields: [
                { name: '━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
                { name: sourceEmoji + ' Location', value: brainrot.source === 'plot' ? 'Plot' : brainrot.source === 'carpet' ? 'Carpet' : 'Unknown', inline: true },
                { name: '👥 Players', value: `${brainrot.players || 0}/8`, inline: true },
                { name: isHighValue ? '🔥 PREMIUM' : '💎 Standard', value: isHighValue ? 'High Value' : 'Regular', inline: true }
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
            content: isHighValue ? `🔥 **ALERTE 100M+** 🔥\n${brainrot.name} - ${formattedValue}` : null,
            embeds: [embed]
        };

        const response = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error('[DISCORD] HTTP Error:', response.status, response.statusText);
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after') || '5';
                console.error('[DISCORD] Rate limited! Wait ' + retryAfter + 's');
            }
        } else {
            console.log('[DISCORD] Alert sent:', brainrot.name, `(${formattedValue})`, isHighValue ? '🔥 HIGH' : '💎 LOW');
        }
    } catch (e) {
        console.error('[DISCORD] Error:', e.message);
    }
}

async function sendDiscordAlert(brainrot) {
    discordQueue.push(brainrot);
    if (discordQueue.length >= DISCORD_BATCH_SIZE) {
        clearTimeout(discordBatchTimer);
        await flushDiscordBatch();
        return;
    }
    if (!discordBatchTimer) {
        discordBatchTimer = setTimeout(flushDiscordBatch, DISCORD_BATCH_INTERVAL);
    }
}

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

async function scanPool() {
    const newPool = [];
    let cursor = '';
    let totalScanned = 0, total7or8 = 0, pagesScanned = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await fetchServers(cursor);
        if (!data || !data.data) break;
        pagesScanned++;
        for (const server of data.data) {
            totalScanned++;
            if (server.playing === 7 || server.playing === 8) {
                total7or8++;
                if (!blacklist.has(server.id)) {
                    const s = { jobId: server.id, players: server.playing, maxPlayers: server.maxPlayers };
                    newPool.push(s);
                }
            }
        }
        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
        await new Promise(r => setTimeout(r, 200));
    }
    if (pagesScanned === 0) {
        console.log('[SCAN] All proxies dead, pool conservé (' + pool.length + ' serveurs)');
        return;
    }
    pool = newPool;
    stats.totalScans++;
    console.log('[SCAN] Pages: ' + pagesScanned + ' | Total scanned: ' + totalScanned + ' | 7/8 found: ' + total7or8 + ' | Pool (fresh): ' + newPool.length + ' | Blacklisted: ' + blacklist.size);
}

async function scanLoop() {
    while (true) {
        try { await scanPool(); } catch (e) { console.error('[SCAN] Error:', e.message); }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
}

app.get('/', (req, res) => res.json({
    name: 'Godzilla Notifier', version: '8.4 Simplified',
    pool: pool.length,
    config: { scanInterval: SCAN_INTERVAL + 'ms', maxPages: MAX_PAGES, proxies: PROXIES.length }
}));

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Math.floor((Date.now() - stats.startedAt) / 1000), pool: pool.length }));

app.get('/jobs', (req, res) => {
    if (!checkAuth(req, res)) return;
    const username = req.headers.username || 'anonymous';
    if (!pool || pool.length === 0) return res.status(503).send('Pool empty');
    if (!botHistory.has(username)) {
        botHistory.set(username, { firstSeen: Date.now(), lastSeen: Date.now(), jobsReceived: 0, currentJobId: null });
    }
    const botData = botHistory.get(username);
    botData.lastSeen = Date.now();
    botData.jobsReceived++;
    const selected = pool[Math.floor(Math.random() * pool.length)];
    const idx = pool.findIndex(s => s.jobId === selected.jobId);
    if (idx !== -1) pool.splice(idx, 1);
    blacklist.set(selected.jobId, Date.now() + BLACKLIST_TTL);
    botData.currentJobId = selected.jobId;
    stats.jobsServed++;
    console.log('[JOBS] ' + username + ' -> ' + selected.jobId.substring(0, 12) + '... Players: ' + selected.players + '/8 | Pool reste: ' + pool.length);
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
    logBuffer.push({ botName, message, timestamp: Date.now() });
    if (logBuffer.length >= LOG_BATCH_SIZE) {
        clearTimeout(logBatchTimer);
        flushLogBatch();
        logBatchTimer = setTimeout(flushLogBatch, LOG_BATCH_INTERVAL);
    } else if (!logBatchTimer) {
        logBatchTimer = setTimeout(flushLogBatch, LOG_BATCH_INTERVAL);
    }
    res.json({ success: true, queued: logBuffer.length });
});

app.get('/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    const m = uptime / 60;
    res.json({
        uptime, pool: pool.length,
        totalScans: stats.totalScans,
        jobsServed: stats.jobsServed,
        jobsPerMinute: m > 0 ? Math.round(stats.jobsServed / m) : 0,
        reportsReceived: stats.reportsReceived, 
        reportsWithBrainrots: stats.reportsWithBrainrots,
        reportsHitRate: stats.reportsReceived > 0 ? Math.round((stats.reportsWithBrainrots / stats.reportsReceived) * 100) + '%' : '0%',
        activeBots: botHistory.size, 
        recentBrainrots: recentBrainrots.length,
        blacklistedServers: blacklist.size,
        discord: { queuedAlerts: discordQueue.length, batchSize: DISCORD_BATCH_SIZE, batchInterval: DISCORD_BATCH_INTERVAL }
    });
});

app.get('/pool', (req, res) => res.json({ count: pool.length, servers: pool.slice(0, 50) }));

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

app.delete('/api/bots', (req, res) => {
    if (!checkAuth(req, res)) return;
    const deletedBots = botHistory.size;
    botHistory.clear();
    jobLocks.clear();
    console.log('[CLEAR] ✅ Cleared ' + deletedBots + ' bots');
    res.json({ success: true, deleted: deletedBots });
});

app.get('/live-monitor', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Godzilla Live Monitor</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Courier New',monospace;background:#000;color:#00ff00;min-height:100vh;padding:20px}.bg{position:fixed;top:0;left:0;width:100%;height:100%;background-image:linear-gradient(rgba(0,255,0,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,0,.02) 1px,transparent 1px);background-size:40px 40px;z-index:-1}.container{max-width:1400px;margin:0 auto}.header{text-align:center;margin-bottom:30px;padding:25px;border:3px solid #00ff00;background:rgba(0,255,0,0.05);box-shadow:0 0 20px rgba(0,255,0,0.2)}.header h1{font-size:52px;text-shadow:0 0 20px #00ff00;letter-spacing:6px;font-weight:900;margin-bottom:10px}.subtitle{font-size:12px;opacity:.7;text-transform:uppercase;letter-spacing:3px}.controls{display:flex;gap:20px;justify-content:center;align-items:center;margin-bottom:30px;flex-wrap:wrap;padding:20px;border:2px solid #00ff00;background:rgba(0,255,0,0.03)}.slider-group{display:flex;align-items:center;gap:15px}.slider-label{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:2px;color:#ffff00}input[type="range"]{width:200px;cursor:pointer}.slider-value{font-size:16px;font-weight:900;color:#ffff00;min-width:60px}.clear-btn{background:#f55;color:#000;border:2px solid #f55;padding:12px 30px;font-size:16px;font-weight:900;cursor:pointer;text-transform:uppercase;letter-spacing:2px;transition:all 0.3s;font-family:'Courier New',monospace}.clear-btn:hover{background:#ff0000;box-shadow:0 0 30px rgba(255,0,0,0.8)}.clear-btn:disabled{background:#888;cursor:not-allowed;opacity:0.5}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:15px;margin-bottom:30px}.stat-box{background:rgba(0,255,0,0.05);border:2px solid #00ff00;padding:20px;text-align:center;box-shadow:0 0 15px rgba(0,255,0,0.2);transition:all 0.3s}.stat-box:hover{transform:translateY(-3px);box-shadow:0 0 25px rgba(0,255,0,0.4)}.stat-label{font-size:11px;opacity:.7;text-transform:uppercase;margin-bottom:10px;letter-spacing:2px}.stat-value{font-size:42px;font-weight:900;color:#ffff00;text-shadow:0 0 10px #ffff00}.stat-sub{font-size:11px;opacity:.6;margin-top:8px}.bots-section{background:#000;border:2px solid #00ff00;padding:25px;box-shadow:0 0 15px rgba(0,255,0,0.2)}.bots-title{font-size:16px;font-weight:900;color:#ffff00;margin-bottom:20px;text-transform:uppercase;letter-spacing:2px}.bots-list{display:grid;gap:20px}.bot-card{background:#000;border:2px solid #00ff00;padding:25px;min-height:140px;position:relative;overflow:hidden;transition:all 0.3s}.bot-card:hover{box-shadow:0 0 20px rgba(0,255,0,0.4)}.bot-name{font-size:32px;font-weight:900;color:#fff;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px}.bot-stats{display:flex;gap:20px;font-size:13px;margin-bottom:12px}.bot-stat{opacity:.7}.bot-status{font-size:16px;font-weight:900}.status-active{color:#00ff00}.status-slow{color:#fa0}.status-idle{color:#f55}.timer-bar{position:absolute;bottom:0;left:0;height:8px;background:#00ff00;transition:all 0.3s}.footer{text-align:center;padding:20px;opacity:.4;font-size:11px;border-top:1px solid #00ff00;text-transform:uppercase;margin-top:40px}</style></head><body><div class="bg"></div><div class="container"><div class="header"><h1>🔥 GODZILLA LIVE MONITOR 🔥</h1><div class="subtitle">v8.4 Simplified — Real-time Bot Status</div></div><div class="controls"><div class="slider-group"><span class="slider-label">📏 Bot Line Size:</span><input type="range" id="sizeSlider" min="1" max="2.5" step="0.1" value="1"/><span class="slider-value" id="sizeValue">1.0x</span></div><button class="clear-btn" id="clearBtn" onclick="clearAllBots()">❌ CLEAR ALL BOTS</button></div><div class="grid"><div class="stat-box"><div class="stat-label">Server Pool</div><div class="stat-value" id="stat-pool">0</div><div class="stat-sub" id="stat-scans">0 scans</div></div><div class="stat-box"><div class="stat-label">Jobs/Minute</div><div class="stat-value" id="stat-jobsmin">0</div><div class="stat-sub" id="stat-jobstotal">0 served</div></div><div class="stat-box"><div class="stat-label">Hit Rate</div><div class="stat-value" id="stat-hitrate">0%</div><div class="stat-sub" id="stat-reports">0 reports</div></div><div class="stat-box"><div class="stat-label">Active Bots</div><div class="stat-value" id="stat-active">0/0</div><div class="stat-sub" id="stat-uptime">uptime</div></div><div class="stat-box"><div class="stat-label">Blacklisted</div><div class="stat-value" id="stat-quality">0</div><div class="stat-sub">10min TTL</div></div><div class="stat-box"><div class="stat-label">Live Brainrots</div><div class="stat-value" id="stat-brainrots">0</div><div class="stat-sub">TTL 30s</div></div></div><div class="bots-section"><div class="bots-title">📊 Bots Detail</div><div class="bots-list" id="bots-list"><div style="text-align:center;opacity:0.5;padding:40px">No bots yet...</div></div></div><div class="footer">Dev by SALAH | Godzilla v8.4 | Auto-refresh 2s | /dashboard | /stats</div></div><script>let sizeMultiplier=1;document.getElementById('sizeSlider').addEventListener('change',(e)=>{sizeMultiplier=parseFloat(e.target.value);document.getElementById('sizeValue').textContent=sizeMultiplier.toFixed(1)+'x';updateBotDisplay();});async function clearAllBots(){const btn=document.getElementById('clearBtn');btn.disabled=true;btn.textContent='⏳ CLEARING...';try{const response=await fetch('/api/bots',{method:'DELETE',headers:{'Content-Type':'application/json','x-api-key':'SALAH2026'}});if(!response.ok){const error=await response.json();alert('Error: '+(error.error||'Unknown error'));btn.textContent='❌ CLEAR ALL BOTS';btn.disabled=false;return;}const result=await response.json();const botsList=document.getElementById('bots-list');botsList.innerHTML='<div style="text-align:center;opacity:0.5;padding:40px">No bots yet...</div>';const stats=await fetch("/stats").then(r=>r.json());const uptime=Math.floor(stats.uptime/60);document.getElementById('stat-active').textContent='0/'+result.deleted;document.getElementById('stat-uptime').textContent=uptime+'min uptime';btn.textContent='✅ CLEARED '+result.deleted+' BOTS';setTimeout(()=>{btn.textContent='❌ CLEAR ALL BOTS';btn.disabled=false;},3000);}catch(e){console.error('Clear failed:',e);alert('Failed to clear: '+e.message);btn.textContent='❌ CLEAR ALL BOTS';btn.disabled=false;}}async function updateMonitor(){try{const [stats,bots]=await Promise.all([fetch("/stats").then(r=>r.json()),fetch("/bots").then(r=>r.json())]);const uptime=Math.floor(stats.uptime/60);const activeBots=bots.filter(b=>b.secondsSinceLastSeen<30).length;document.getElementById('stat-pool').textContent=stats.pool;document.getElementById('stat-scans').textContent=stats.totalScans+' scans';document.getElementById('stat-jobsmin').textContent=stats.jobsPerMinute;document.getElementById('stat-jobstotal').textContent=stats.jobsServed+' served';document.getElementById('stat-hitrate').textContent=stats.reportsHitRate;document.getElementById('stat-reports').textContent=stats.reportsReceived+' reports';document.getElementById('stat-active').textContent=activeBots+'/'+bots.length;document.getElementById('stat-uptime').textContent=uptime+'min uptime';document.getElementById('stat-quality').textContent=stats.blacklistedServers;document.getElementById('stat-brainrots').textContent=stats.recentBrainrots;updateBotDisplay();}catch(e){console.error('Update error:',e);}}async function updateBotDisplay(){try{const bots=await fetch("/bots").then(r=>r.json());const list=document.getElementById('bots-list');if(bots.length===0){list.innerHTML='<div style="text-align:center;opacity:0.5;padding:40px">No bots yet...</div>';return;}list.innerHTML=bots.map(bot=>{const secondsSince=bot.secondsSinceLastSeen;let statusClass='status-idle';let statusText='❌ IDLE';let statusColor='#f55';if(secondsSince<60){statusClass='status-active';statusText='✅ ACTIVE';statusColor='#00ff00';}else if(secondsSince<100){statusClass='status-slow';statusText='⚠️ SLOW';statusColor='#fa0';}const baseHeight=140;const scaledHeight=baseHeight*sizeMultiplier;const progressWidth=Math.max(0,Math.min(100,(secondsSince/120)*100));return '<div class="bot-card" style="min-height:'+scaledHeight+'px;border-color:'+statusColor+';"><div class="bot-name" style="font-size:'+(32*sizeMultiplier)+'px;">'+bot.name+'</div><div class="bot-stats" style="font-size:'+(13*sizeMultiplier)+'px;"><div class="bot-stat">Jobs: '+bot.jobsReceived+'</div><div class="bot-stat">Seen: '+secondsSince+'s ago</div><div class="bot-stat bot-status '+statusClass+'">'+statusText+'</div></div><div class="timer-bar" style="background:'+statusColor+';width:'+progressWidth+'%;"></div></div>';}).join('');}catch(e){console.error('Display error:',e);}}updateMonitor();setInterval(updateMonitor,2000);</script></body></html>`);
});

app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Godzilla Dashboard</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Courier New',monospace;background:#000;color:#00ff00;padding:20px}.bg{position:fixed;top:0;left:0;width:100%;height:100%;background-image:linear-gradient(rgba(0,255,0,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,0,.03) 1px,transparent 1px);background-size:50px 50px;z-index:-1}.container{max-width:1200px;margin:0 auto}.header{text-align:center;margin-bottom:40px;padding:30px;border:3px solid #00ff00}.header h1{font-size:48px;text-shadow:0 0 20px #00ff00;letter-spacing:8px;font-weight:900}.empty{text-align:center;padding:100px 20px;font-size:20px;border:3px dashed #00ff00;opacity:.3}.list{display:grid;gap:20px}.card{background:#000;border:3px solid #00ff00;padding:25px;position:relative}.top-card{border-color:#ffd700}.name{font-size:24px;font-weight:900;color:#fff}.val{font-size:40px;font-weight:900;color:#00ff00}.badge{display:inline-block;padding:5px 10px;background:#00ff00;color:#000;font-size:11px;font-weight:900;margin-right:5px}.timer{border:2px solid #00ff00;padding:7px 14px;font-size:17px;font-weight:900}.prog{position:absolute;bottom:0;left:0;height:5px;background:#00ff00}.footer{text-align:center;margin-top:40px;padding:20px;opacity:.4;font-size:12px;border-top:1px solid #00ff00}</style></head><body><div class="bg"></div><div class="container"><div class="header"><h1>GODZILLA NOTIFIER</h1><div>v8.4 Simplified</div></div><div id="app"><div class="empty">EN ATTENTE DE BRAINROTS...</div></div><div class="footer">Dev by SALAH | Discord Alerts Enabled | /live-monitor | /stats</div></div><script>function fmt(n){if(!n)return"$0/s";const a=Math.abs(n);if(a>=1e12)return"$"+(n/1e12).toFixed(1).replace(/\.0$/,"")+"T/s";if(a>=1e9)return"$"+(n/1e9).toFixed(1).replace(/\.0$/,"")+"B/s";if(a>=1e6)return"$"+(n/1e6).toFixed(1).replace(/\.0$/,"")+"M/s";if(a>=1e3)return"$"+(n/1e3).toFixed(1).replace(/\.0$/,"")+"K/s";return"$"+Math.round(n)+"/s";}function render(b){const c=document.getElementById("app");if(!b||!b.length){c.innerHTML='<div class="empty">EN ATTENTE DE BRAINROTS...</div>';return;}b.sort((x,y)=>y.numeric-x.numeric);const l=document.createElement("div");l.className="list";b.forEach((x,i)=>{const r=x.remainingSeconds||0;const d=document.createElement("div");d.className="card"+(i===0?" top-card":"");d.innerHTML='<div style="display:flex;justify-content:space-between"><div><span class="badge">'+x.players+'/8</span><div class="name">'+x.name+'</div></div><div class="val">'+fmt(x.numeric)+'</div></div><div style="font-size:12px;opacity:.6">BOT: '+x.botName+'</div><div class="prog" style="width:'+(r/30*100)+'%"></div>';l.appendChild(d);});c.innerHTML="";c.appendChild(l);}fetch("/api/brainrots").then(r=>r.json()).then(render);setInterval(()=>fetch("/api/brainrots").then(r=>r.json()).then(render),1000);</script></body></html>`);
});

app.listen(PORT, () => {
    console.log('================================================');
    console.log('GODZILLA NOTIFIER v8.4 SIMPLIFIED - 7/8 ONLY');
    console.log('PlaceId: ' + PLACE_ID);
    console.log('Scan: toutes les ' + (SCAN_INTERVAL/1000) + 's | Pages: ' + MAX_PAGES);
    console.log('Filter: ONLY 7 ou 8 players');
    console.log('Blacklist: ' + (BLACKLIST_TTL/60000) + ' minutes');
    console.log('Proxies cascade:');
    PROXIES.forEach(p => console.log('  - ' + p));
    console.log('Discord Configuration:');
    console.log('  - Webhook 100M+: ' + DISCORD_WEBHOOK_HIGH.substring(0, 60) + '...');
    console.log('  - Webhook < 100M: ' + DISCORD_WEBHOOK_LOW.substring(0, 60) + '...');
    console.log('  - Batch Size: ' + DISCORD_BATCH_SIZE + ' alerts max');
    console.log('  - Batch Interval: ' + (DISCORD_BATCH_INTERVAL/1000) + 's');
    console.log('  - Anti-spam: ' + ANTI_SPAM_DELAY + 'ms delay');
    console.log('Log Batching: ' + LOG_BATCH_SIZE + ' max per ' + (LOG_BATCH_INTERVAL/1000) + 's');
    console.log('PORT: ' + PORT);
    console.log('================================================');
    scanLoop();
});
