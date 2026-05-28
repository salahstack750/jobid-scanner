// Godzilla Notifier Backend - v7.2
// 10 proxies HTTP rotatifs + 10 workers
// By SALAH

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';
const PLACE_ID = '109983668079237';

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 7;
const JOBID_LOCK_TTL = 30 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const BRAINROT_TTL = 30 * 1000;
const MIN_BRAINROT_VALUE = 1000000;
const MAX_LOGS = 200;
const FILTERING_ENABLED = true;
const MIN_FPS = 35;
const MAX_PING = 500;
const TOP_DISTRIBUTION_RATIO = 0.7;
const NUM_SCRAPERS = 10;

// ============================================================
// PROXY PARSER — supporte 2 formats
// ============================================================

function parseProxy(str) {
    if (!str) return null;
    str = str.trim();
    if (!str) return null;

    // Format A: user:pass@host:port
    if (str.includes('@')) {
        const at = str.lastIndexOf('@');
        const left = str.slice(0, at);
        const right = str.slice(at + 1);
        const [host, portStr] = right.split(':');
        const colon = left.indexOf(':');
        if (colon === -1 || !host || !portStr) return null;
        return { host, port: parseInt(portStr), user: left.slice(0, colon), pass: left.slice(colon + 1) };
    }

    // Format B: host:port:user:pass
    const parts = str.split(':');
    if (parts.length === 4) {
        return { host: parts[0], port: parseInt(parts[1]), user: parts[2], pass: parts[3] };
    }

    // Format C: host:port (no auth)
    if (parts.length === 2) {
        return { host: parts[0], port: parseInt(parts[1]), user: null, pass: null };
    }

    return null;
}

function buildAgent(proxyObj) {
    if (!proxyObj) return null;
    const auth = proxyObj.user && proxyObj.pass ? proxyObj.user + ':' + proxyObj.pass + '@' : '';
    try {
        return new HttpsProxyAgent('http://' + auth + proxyObj.host + ':' + proxyObj.port);
    } catch (e) { return null; }
}

// ============================================================
// PROXIES — chargement depuis proxies.txt
// ============================================================

let proxyList = []; // [{ str, parsed, ok, fail, last429 }]
let proxyIndex = 0;

function loadProxies() {
    try {
        const raw = fs.readFileSync('proxies.txt', 'utf8');
        const lines = [...new Set(raw.split('\n').map(l => l.trim()).filter(l => l.length > 0))];
        proxyList = lines.map(str => {
            const parsed = parseProxy(str);
            return parsed ? { str, parsed, ok: 0, fail: 0, last429: 0 } : null;
        }).filter(p => p !== null);
        console.log('[PROXIES] ' + proxyList.length + ' proxies valides charges');
        proxyList.forEach((p, i) => console.log('  [' + i + '] ' + p.parsed.host + ':' + p.parsed.port));
    } catch (e) {
        console.error('[PROXIES] Erreur chargement proxies.txt: ' + e.message);
        proxyList = [];
    }
}

function getNextProxy() {
    if (proxyList.length === 0) return null;
    const proxy = proxyList[proxyIndex % proxyList.length];
    proxyIndex++;
    return proxy;
}

// ============================================================
// ENDPOINTS
// ============================================================

const ENDPOINTS = [
    'https://games.roblox.com/v1/games/' + PLACE_ID + '/servers/Public?limit=100&excludeFullGames=true&sortOrder=Asc',
    'https://games.roblox.com/v1/games/' + PLACE_ID + '/servers/Public?limit=100&excludeFullGames=true&sortOrder=Desc',
    'https://games.roblox.com/v1/games/' + PLACE_ID + '/servers/Public?limit=100&sortOrder=Asc',
    'https://games.roblox.com/v1/games/' + PLACE_ID + '/servers/Public?limit=100&sortOrder=Desc'
];

// ============================================================
// STATE
// ============================================================

const serverPool = new Map();
const dispensedServers = new Map();
const botHistory = new Map();
const recentBrainrots = [];
const liveLogs = [];
const scraperDelays = {};

const stats = {
    totalScraped: 0, jobsServed: 0, jobsServedTopScore: 0, jobsServedRandom: 0,
    reportsReceived: 0, reportsWithBrainrots: 0, logsReceived: 0,
    rateLimits: 0, startedAt: Date.now()
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
    if (key !== API_KEY) { res.status(401).json({ error: 'Invalid API key' }); return false; }
    return true;
}

// ============================================================
// FETCH avec proxy
// ============================================================

async function fetchPage(url, proxy, workerId) {
    const delay = scraperDelays[workerId] || 300;
    if (!proxy) {
        console.log('[W' + workerId + '] Pas de proxy dispo');
        return null;
    }

    const agent = buildAgent(proxy.parsed);
    if (!agent) {
        proxy.fail++;
        console.log('[W' + workerId + '] Agent invalide pour ' + proxy.parsed.host);
        return null;
    }

    try {
        const response = await axios.get(url, {
            httpsAgent: agent,
            proxy: false,
            timeout: 12000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' }
        });
        proxy.ok++;
        scraperDelays[workerId] = Math.max(150, delay - 30);
        return response.data;
    } catch (e) {
        proxy.fail++;
        if (e.response && e.response.status === 429) {
            stats.rateLimits++;
            proxy.last429 = Date.now();
            scraperDelays[workerId] = Math.min(8000, delay + 500);
            console.log('[W' + workerId + '] 429 via ' + proxy.parsed.host + ' (delai: ' + scraperDelays[workerId] + 'ms)');
        } else {
            console.log('[W' + workerId + '] ERR ' + (e.code || e.message) + ' via ' + proxy.parsed.host);
        }
        return null;
    }
}

// ============================================================
// SCRAPER WORKER
// ============================================================

async function scraperWorker(workerId) {
    scraperDelays[workerId] = 300 + workerId * 100;
    console.log('[W' + workerId + '] Demarrage (delai initial: ' + scraperDelays[workerId] + 'ms)');

    while (true) {
        const endpoint = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
        let cursor = null;
        let newCount = 0;
        let pages = 0;

        while (pages < 15) {
            const url = cursor ? endpoint + '&cursor=' + cursor : endpoint;
            await new Promise(r => setTimeout(r, scraperDelays[workerId]));

            const data = await fetchPage(url, getNextProxy(), workerId);
            if (!data || !data.data) break;

            let pageNew = 0;
            for (const server of data.data) {
                if (!server.id) continue;
                if (server.playing < MIN_PLAYERS || server.playing > MAX_PLAYERS) continue;
                if (FILTERING_ENABLED) {
                    if (server.fps !== undefined && server.fps < MIN_FPS) continue;
                    if (server.ping !== undefined && server.ping > MAX_PING) continue;
                }
                if (!serverPool.has(server.id)) {
                    const s = { jobId: server.id, players: server.playing, fps: server.fps, ping: server.ping, addedAt: Date.now() };
                    s.score = calculateServerScore(s);
                    serverPool.set(server.id, s);
                    stats.totalScraped++;
                    pageNew++;
                    newCount++;
                }
            }

            pages++;
            if (pageNew === 0 && pages > 2) break;
            if (!data.nextPageCursor) break;
            cursor = data.nextPageCursor;
        }

        if (newCount > 0) {
            console.log('[W' + workerId + '] +' + newCount + ' (Pool: ' + serverPool.size + ' | 429s: ' + stats.rateLimits + ')');
            await new Promise(r => setTimeout(r, 2000));
        } else {
            await new Promise(r => setTimeout(r, 6000));
        }
    }
}

function startScrapers() {
    console.log('[SCRAPERS] Demarrage ' + NUM_SCRAPERS + ' workers...');
    for (let i = 0; i < NUM_SCRAPERS; i++) {
        setTimeout(() => scraperWorker(i), i * 300);
    }
}

// ============================================================
// NETTOYAGE AUTO
// ============================================================

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of dispensedServers.entries()) { if (v.expiresAt < now) dispensedServers.delete(k); }
    for (const [k, v] of botHistory.entries()) { if (now - v.lastSeen > BOT_HISTORY_TTL) botHistory.delete(k); }
    for (let i = recentBrainrots.length - 1; i >= 0; i--) { if (recentBrainrots[i].expiresAt < now) recentBrainrots.splice(i, 1); }
    for (const [jobId, s] of serverPool.entries()) { if (now - s.addedAt > 30 * 60 * 1000) serverPool.delete(jobId); }
}, 15000);

// Stats proxies toutes les 30s
setInterval(() => {
    if (proxyList.length === 0) return;
    console.log('[PROXY STATS]');
    proxyList.forEach((p, i) => {
        const total = p.ok + p.fail;
        const rate = total > 0 ? Math.round((p.ok / total) * 100) : 0;
        console.log('  [' + i + '] ' + p.parsed.host + ': ' + p.ok + ' OK / ' + p.fail + ' FAIL (' + rate + '%)');
    });
}, 30000);

// ============================================================
// API ENDPOINTS
// ============================================================

app.get('/', (req, res) => res.json({
    name: 'Godzilla Notifier', version: '7.2',
    pool: serverPool.size, scrapers: NUM_SCRAPERS, proxies: proxyList.length
}));

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Math.floor((Date.now() - stats.startedAt) / 1000), pool: serverPool.size }));

app.get('/jobs', (req, res) => {
    if (!checkAuth(req, res)) return;
    const username = req.headers.username || 'anonymous';
    const now = Date.now();

    const available = [...serverPool.values()].filter(s => {
        const lock = dispensedServers.get(s.jobId);
        return !lock || lock.expiresAt < now;
    });

    if (available.length === 0) return res.status(503).send('Pool empty');

    if (!botHistory.has(username)) {
        botHistory.set(username, { firstSeen: now, lastSeen: now, jobsReceived: 0, currentJobId: null, visitedJobs: new Set() });
    }
    const botData = botHistory.get(username);
    botData.lastSeen = now;
    botData.jobsReceived++;

    const candidates = available.filter(s => !botData.visitedJobs.has(s.jobId));
    if (candidates.length === 0) { botData.visitedJobs = new Set(); return res.status(503).send('All visited'); }

    candidates.sort((a, b) => b.score - a.score);

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

    dispensedServers.set(selected.jobId, { botName: username, expiresAt: now + JOBID_LOCK_TTL });
    botData.currentJobId = selected.jobId;
    botData.visitedJobs.add(selected.jobId);
    stats.jobsServed++;

    console.log('[JOBS] ' + username + ' -> ' + selected.jobId.substring(0, 12) + '... Score:' + selected.score + ' (' + (useTopScore ? 'TOP' : 'RND') + ') Pool: ' + serverPool.size);
    res.send(selected.jobId);
});

app.post('/report-data', (req, res) => {
    if (!checkAuth(req, res)) return;
    const { botName, jobId, name, money, numeric = 0, mutation, brainrots, source, players } = req.body || {};
    if (!botName || !jobId) return res.status(400).json({ error: 'Missing botName or jobId' });
    stats.reportsReceived++;
    let hasValid = false;
    if (Array.isArray(brainrots) && brainrots.length > 0) {
        const now = Date.now();
        for (const item of brainrots) {
            if (item.numeric >= MIN_BRAINROT_VALUE && item.name) {
                hasValid = true;
                const dup = recentBrainrots.some(e => e.name === item.name && e.numeric === item.numeric && e.jobId === jobId && e.expiresAt > now);
                if (!dup) {
                    recentBrainrots.unshift({ botName, jobId, name: item.name, money: item.money, numeric: item.numeric, mutation: item.mutation || null, source: item.source || 'unknown', players: players || 0, receivedAt: now, expiresAt: now + BRAINROT_TTL });
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
        uptime, pool: serverPool.size, scrapers: NUM_SCRAPERS, proxies: proxyList.length,
        totalScraped: stats.totalScraped, rateLimits: stats.rateLimits,
        jobsServed: stats.jobsServed, jobsServedTopScore: stats.jobsServedTopScore, jobsServedRandom: stats.jobsServedRandom,
        jobsPerMinute: m > 0 ? Math.round(stats.jobsServed / m) : 0,
        reportsReceived: stats.reportsReceived, reportsWithBrainrots: stats.reportsWithBrainrots,
        reportsHitRate: stats.reportsReceived > 0 ? Math.round((stats.reportsWithBrainrots / stats.reportsReceived) * 100) + '%' : '0%',
        activeBots: botHistory.size, recentBrainrots: recentBrainrots.length,
        scraperDelays,
        proxyStats: proxyList.map(p => ({ host: p.parsed.host, ok: p.ok, fail: p.fail }))
    });
});

app.get('/pool', (req, res) => {
    const sorted = [...serverPool.values()].sort((a, b) => b.score - a.score);
    res.json({ count: sorted.length, servers: sorted.slice(0, 50) });
});

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
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Live Monitor</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Courier New,monospace;background:#0a0a0a;color:#00ff00;padding:20px}h1{text-align:center;margin-bottom:20px;text-shadow:0 0 10px #00ff00}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:15px;margin-bottom:20px}.box{background:#111;border:1px solid #00ff00;padding:15px}.box h3{color:#ffff00;margin-bottom:10px;font-size:13px}.val{font-size:32px;font-weight:bold}.sub{font-size:11px;opacity:.7;margin-top:5px}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:11px}th,td{padding:4px 8px;text-align:left;border-bottom:1px solid #002200}th{background:#001100;color:#ffff00}.good{color:#00ff00}.bad{color:#f00}.warn{color:#fa0}.refresh{text-align:center;opacity:.5;font-size:10px;margin-top:20px}</style></head><body><h1>GODZILLA v7.2 — 10 PROXIES ROTATIFS</h1><div id="c">Loading...</div><div class="refresh">Auto-refresh 2s</div><script>async function r(){const[s,b]=await Promise.all([fetch("/stats").then(x=>x.json()),fetch("/bots").then(x=>x.json())]);const u=Math.floor(s.uptime/60)+"min";const ab=b.filter(x=>x.secondsSinceLastSeen<30).length;let h=\'<div class="grid">\';h+=\'<div class="box"><h3>POOL</h3><div class="val good">\'+s.pool+\'</div><div class="sub">\'+s.totalScraped+\' scrapes</div></div>\';h+=\'<div class="box"><h3>JOBS/MIN</h3><div class="val">\'+s.jobsPerMinute+\'</div><div class="sub">\'+s.jobsServed+\' servis</div></div>\';h+=\'<div class="box"><h3>HIT RATE</h3><div class="val \'+(parseInt(s.reportsHitRate)>30?"good":"warn")+\'">\'+s.reportsHitRate+\'</div><div class="sub">\'+s.reportsReceived+\' reports</div></div>\';h+=\'<div class="box"><h3>BOTS</h3><div class="val">\'+ab+\'/\'+b.length+\'</div><div class="sub">uptime: \'+u+\'</div></div>\';h+=\'<div class="box"><h3>429s</h3><div class="val \'+(s.rateLimits>100?"bad":s.rateLimits>30?"warn":"good")+\'">\'+s.rateLimits+\'</div><div class="sub">\'+s.proxies+\' proxies | \'+s.scrapers+\' workers</div></div>\';h+=\'<div class="box"><h3>BRAINROTS</h3><div class="val good">\'+s.recentBrainrots+\'</div><div class="sub">TTL 30s</div></div>\';h+=\'</div>\';if(s.proxyStats){h+=\'<div class="box" style="margin-bottom:15px"><h3>PROXIES</h3><table><tr><th>IP</th><th>OK</th><th>FAIL</th><th>Rate</th></tr>\';s.proxyStats.forEach(p=>{const t=p.ok+p.fail;const rt=t>0?Math.round(p.ok/t*100):0;const c=rt>80?"good":rt>40?"warn":"bad";h+=\'<tr><td>\'+p.host+\'</td><td class="good">\'+p.ok+\'</td><td class="bad">\'+p.fail+\'</td><td class="\'+c+\'">\'+rt+\'%</td></tr>\';});h+=\'</table></div>\';}h+=\'<div class="box"><h3>BOTS DETAIL</h3><table><tr><th>Nom</th><th>Jobs</th><th>Vu il y a</th><th>Status</th></tr>\';b.slice(0,15).forEach(x=>{const st=x.secondsSinceLastSeen<15?\'<span class="good">ACTIVE</span>\':x.secondsSinceLastSeen<60?\'<span class="warn">SLOW</span>\':\'<span class="bad">IDLE</span>\';h+=\'<tr><td>\'+x.name+\'</td><td>\'+x.jobsReceived+\'</td><td>\'+x.secondsSinceLastSeen+\'s</td><td>\'+st+\'</td></tr>\';});h+=\'</table></div>\';document.getElementById("c").innerHTML=h;}r();setInterval(r,2000);</script></body></html>');
});

app.get('/dashboard', (req, res) => {
    res.send('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Godzilla Notifier</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Courier New,monospace;background:#000;color:#00ff00;min-height:100vh;padding:20px}.bg{position:fixed;top:0;left:0;width:100%;height:100%;background-image:linear-gradient(rgba(0,255,0,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,0,.03) 1px,transparent 1px);background-size:50px 50px;z-index:-1}.container{max-width:1200px;margin:0 auto}.header{text-align:center;margin-bottom:40px;padding:30px;border:3px solid #00ff00}.header h1{font-size:48px;text-shadow:0 0 20px #00ff00;letter-spacing:8px;font-weight:900}.subtitle{font-size:13px;opacity:.8;text-transform:uppercase;letter-spacing:4px;margin-top:8px}.empty{text-align:center;padding:100px 20px;font-size:20px;border:3px dashed #00ff00;opacity:.3;text-transform:uppercase;letter-spacing:3px}.list{display:grid;gap:20px}.card{background:#000;border:3px solid #00ff00;padding:25px;position:relative;overflow:hidden;box-shadow:0 0 20px rgba(0,255,0,.3)}.top-card{border-color:#ffd700!important;box-shadow:0 0 30px rgba(255,215,0,.5)!important}.row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}.name{font-size:24px;font-weight:900;color:#fff}.val{font-size:40px;font-weight:900;color:#00ff00;text-shadow:0 0 15px #00ff00}.badge{display:inline-block;padding:5px 10px;background:#00ff00;color:#000;font-size:11px;font-weight:900;margin-right:5px;margin-bottom:8px}.gold{background:#ffd700}.meta{font-size:12px;opacity:.6;margin-bottom:12px}.foot{display:flex;gap:10px;align-items:center}.btn{background:#00ff00;color:#000;border:none;padding:10px 25px;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit}.timer{border:2px solid #00ff00;padding:7px 14px;font-size:17px;font-weight:900;min-width:65px;text-align:center}.fr{color:#00ff00}.md{color:#fa0}.xp{color:#f55}.prog{position:absolute;bottom:0;left:0;height:5px;background:#00ff00}.footer{text-align:center;margin-top:40px;padding:20px;opacity:.4;font-size:12px;border-top:1px solid #00ff00;text-transform:uppercase}</style></head><body><div class="bg"></div><div class="container"><div class="header"><h1>GODZILLA NOTIFIER</h1><div class="subtitle">v7.2 — 10 Proxies HTTP Rotatifs</div></div><div id="app"><div class="empty">EN ATTENTE DE BRAINROTS...</div></div><div class="footer">Dev by SALAH | /live-monitor | /stats</div></div><script>function fmt(n){if(!n)return"$0/s";const a=Math.abs(n);if(a>=1e12)return"$"+(n/1e12).toFixed(1).replace(".0","")+"T/s";if(a>=1e9)return"$"+(n/1e9).toFixed(1).replace(".0","")+"B/s";if(a>=1e6)return"$"+(n/1e6).toFixed(1).replace(".0","")+"M/s";return"$"+(n/1e3).toFixed(1).replace(".0","")+"K/s";}function copy(t){navigator.clipboard.writeText(t).then(()=>{const d=document.createElement("div");d.style="position:fixed;top:20px;right:20px;background:#00ff00;color:#000;padding:15px 25px;font-weight:900;z-index:9999;";d.textContent="COPIE!";document.body.appendChild(d);setTimeout(()=>d.remove(),2000);})}function render(b){const c=document.getElementById("app");if(!b||!b.length){c.innerHTML=\'<div class="empty">EN ATTENTE DE BRAINROTS...</div>\';return;}b.sort((x,y)=>y.numeric-x.numeric);const l=document.createElement("div");l.className="list";b.forEach((x,i)=>{const r=x.remainingSeconds||0;const tc=r<10?"xp":r<20?"md":"fr";const d=document.createElement("div");d.className="card"+(i===0?" top-card":"");d.dataset.e=Date.now()+(r*1000);const src=x.source==="carpet"?"CARPET":x.source==="plot"?"PLOT":"UNKNOWN";const mut=x.mutation&&x.mutation!=="None"?"["+x.mutation+"] ":"";d.innerHTML=\'<div class="row"><div><div>\'+(i===0?\'<span class="badge gold">TOP</span>\':"")+ \'<span class="badge">\'+src+\'</span><span class="badge">\'+x.players+\'/8</span></div><div class="name">\'+mut+x.name+\'</div></div><div class="val">\'+fmt(x.numeric)+\'</div></div><div class="meta">BOT: \'+x.botName+\' &nbsp;|&nbsp; JOB: \'+x.jobId.substring(0,16)+\'...</div><div class="foot"><button class="btn" onclick="copy(\'+"\'"+x.jobId+"\'"+\')">JOIN</button><div class="timer \'+tc+\'">\'+r+\'s</div></div><div class="prog" style="width:\'+(r/30*100)+\'%"></div>\';l.appendChild(d);});c.innerHTML="";c.appendChild(l);}fetch("/api/brainrots").then(r=>r.json()).then(render);setInterval(()=>fetch("/api/brainrots").then(r=>r.json()).then(render),1000);setInterval(()=>{document.querySelectorAll(".card").forEach(c=>{const e=parseInt(c.dataset.e);if(!e)return;const r=Math.max(0,Math.ceil((e-Date.now())/1000));const te=c.querySelector(".timer");const pe=c.querySelector(".prog");if(te){te.textContent=r+"s";te.className="timer "+(r<10?"xp":r<20?"md":"fr");}if(pe)pe.style.width=(r/30*100)+"%";if(r<=0)c.remove();});},1000);</script></body></html>');
});

app.listen(PORT, () => {
    loadProxies();
    console.log('================================================');
    console.log('GODZILLA NOTIFIER v7.2 — 10 PROXIES ROTATIFS');
    console.log('PlaceId: ' + PLACE_ID);
    console.log('Scrapers: ' + NUM_SCRAPERS);
    console.log('Proxies: ' + proxyList.length);
    console.log('PORT: ' + PORT);
    console.log('================================================');
    setTimeout(startScrapers, 500);
});
