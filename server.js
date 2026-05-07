// ═══════════════════════════════════════════════════════════════
//   🎯 RAILWAY JOBID SCANNER - BY SALAH
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'SALAH2026';

const PLACE_IDS = {
    'rebirth0': 96342491571673,
    'rebirth1': 109983668079237
};

const SCAN_INTERVAL = 15000;
const PAGE_DELAY = 2000;
const MAX_PAGES = 5;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 7;
const MAX_POOL_SIZE = 1000;
const POOL_TTL = 3 * 60 * 1000;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const pools = {
    rebirth0: [],
    rebirth1: []
};

let stats = {
    totalScans: 0,
    totalErrors: 0,
    totalRateLimits: 0,
    lastScan: null
};

let scanInProgress = false;

function log(msg, ...args) { console.log(`[${new Date().toISOString()}]`, msg, ...args); }
function warn(msg, ...args) { console.warn(`[${new Date().toISOString()}]`, msg, ...args); }
function error(msg, ...args) { console.error(`[${new Date().toISOString()}]`, msg, ...args); }

async function fetchRobloxServers(placeId, cursor = null, retryCount = 0) {
    let url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&limit=100`;
    if (cursor) url += `&cursor=${cursor}`;
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': getRandomUA(),
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        if (response.status === 429) {
            stats.totalRateLimits++;
            warn(`[FETCH] Rate limited on placeId ${placeId}`);
            if (retryCount < 3) {
                await new Promise(r => setTimeout(r, 5000 * (retryCount + 1)));
                return fetchRobloxServers(placeId, cursor, retryCount + 1);
            }
            return { servers: [], nextCursor: null };
        }

        if (!response.ok) {
            warn(`[FETCH] HTTP ${response.status} on placeId ${placeId}`);
            return { servers: [], nextCursor: null };
        }

        const data = await response.json();
        return {
            servers: data.data || [],
            nextCursor: data.nextPageCursor || null
        };

    } catch (err) {
        error(`[FETCH] Error:`, err.message);
        stats.totalErrors++;
        if (retryCount < 3) {
            await new Promise(r => setTimeout(r, 3000));
            return fetchRobloxServers(placeId, cursor, retryCount + 1);
        }
        return { servers: [], nextCursor: null };
    }
}

async function scanPlace(placeKey, placeId) {
    log(`[SCAN] Scanning ${placeKey} (${placeId})...`);

    let allServers = [];
    let cursor = null;
    let pageCount = 0;

    do {
        pageCount++;
        const result = await fetchRobloxServers(placeId, cursor);
        
        if (result.servers.length > 0) {
            allServers.push(...result.servers);
            log(`[SCAN] ${placeKey} Page ${pageCount}: +${result.servers.length}`);
        } else {
            break;
        }
        
        cursor = result.nextCursor;
        if (pageCount >= MAX_PAGES) break;
        if (cursor) await new Promise(r => setTimeout(r, PAGE_DELAY));
        
    } while (cursor);

    const validServers = allServers.filter(server => {
        const playerCount = server.playing || 0;
        const jobId = server.id;
        return jobId && 
               typeof jobId === 'string' &&
               playerCount >= MIN_PLAYERS && 
               playerCount <= MAX_PLAYERS &&
               !pools[placeKey].some(job => job.jobId === jobId);
    });

    const newJobs = validServers.map(server => ({
        jobId: server.id,
        players: server.playing || 0,
        maxPlayers: server.maxPlayers || 8,
        addedAt: Date.now()
    }));

    pools[placeKey].push(...newJobs);

    const now = Date.now();
    pools[placeKey] = pools[placeKey].filter(job => (now - job.addedAt) < POOL_TTL);
    
    if (pools[placeKey].length > MAX_POOL_SIZE) {
        pools[placeKey] = pools[placeKey].slice(-MAX_POOL_SIZE);
    }

    log(`[SCAN] ${placeKey} ✅ Added ${newJobs.length} | Pool: ${pools[placeKey].length}`);
}

async function scanAll() {
    if (scanInProgress) return;
    scanInProgress = true;

    try {
        log(`\n[SCAN] ====== Scan #${stats.totalScans + 1} ======`);
        
        await scanPlace('rebirth1', PLACE_IDS.rebirth1);
        await new Promise(r => setTimeout(r, 1000));
        await scanPlace('rebirth0', PLACE_IDS.rebirth0);

        stats.totalScans++;
        stats.lastScan = new Date().toISOString();
        
        log(`[SCAN] ✅ Complete | Pools: rebirth1=${pools.rebirth1.length}, rebirth0=${pools.rebirth0.length}\n`);
    } catch (err) {
        error(`[SCAN] Error:`, err.message);
        stats.totalErrors++;
    } finally {
        scanInProgress = false;
    }
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'JobID Scanner API by SALAH',
        endpoints: {
            jobs: '/jobs?placeId=109983668079237&key=SALAH2026',
            pool: '/pool?key=SALAH2026',
            health: '/health'
        },
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1: pools.rebirth1.length
        }
    });
});

app.get('/jobs', (req, res) => {
    const apiKey = req.query.key;
    const placeId = req.query.placeId;
    const username = req.headers.username || 'Unknown';

    if (apiKey !== API_KEY) {
        return res.status(401).send('Unauthorized');
    }

    let placeKey = 'rebirth1';
    if (placeId == PLACE_IDS.rebirth0) placeKey = 'rebirth0';

    const pool = pools[placeKey];

    if (pool.length === 0) {
        warn(`[JOBS] Pool empty (${placeKey}) for ${username}`);
        return res.status(503).send('No servers available');
    }

    const randomIndex = Math.floor(Math.random() * pool.length);
    const selectedJob = pool[randomIndex];

    log(`[JOBS] ✅ ${selectedJob.jobId.substring(0, 12)}... → ${username} | ${selectedJob.players}p | ${placeKey}`);

    res.send(selectedJob.jobId);
});

app.get('/pool', (req, res) => {
    if (req.query.key !== API_KEY) return res.status(401).send('Unauthorized');

    res.json({
        rebirth0: {
            poolSize: pools.rebirth0.length,
            sample: pools.rebirth0.slice(0, 5).map(j => ({
                jobId: j.jobId.substring(0, 12) + '...',
                players: j.players
            }))
        },
        rebirth1: {
            poolSize: pools.rebirth1.length,
            sample: pools.rebirth1.slice(0, 5).map(j => ({
                jobId: j.jobId.substring(0, 12) + '...',
                players: j.players
            }))
        },
        stats
    });
});

app.get('/health', (req, res) => {
    const isHealthy = (pools.rebirth0.length + pools.rebirth1.length) > 5;
    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'degraded',
        pools: {
            rebirth0: pools.rebirth0.length,
            rebirth1: pools.rebirth1.length
        }
    });
});

app.listen(PORT, () => {
    log(`\n═══════════════════════════════════════════════════════════`);
    log(`  🎯 JOBID SCANNER - BY SALAH - RAILWAY EDITION`);
    log(`═══════════════════════════════════════════════════════════`);
    log(`✅ Port: ${PORT}`);
    log(`✅ API Key: ${API_KEY}`);
    log(`✅ Players: ${MIN_PLAYERS}-${MAX_PLAYERS}`);
    log(`✅ Scan interval: ${SCAN_INTERVAL / 1000}s`);
    log(`═══════════════════════════════════════════════════════════\n`);

    scanAll();
    setInterval(scanAll, SCAN_INTERVAL);
});

process.on('uncaughtException', (err) => error(`[FATAL]`, err));
process.on('unhandledRejection', (reason) => error(`[FATAL]`, reason));
