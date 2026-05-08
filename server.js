const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
//                    CONFIG
// ═══════════════════════════════════════════════════════════════

const API_KEY = "SALAH2026";
const PROXY_URL = "https://roblox-proxy.salahelarabi03.workers.dev";

const PLACES = {
    REBIRTH_0: "96342491571673",
    REBIRTH_1_PLUS: "109983668079237"
};

// Scanner config
const SCAN_INTERVAL = 15000;          // Re-scan toutes les 15s
const MAX_PAGES = 10;                  // Scan 10 pages max
const MIN_PLAYERS = 6;                 // Min 6 joueurs
const MAX_PLAYERS = 7;                 // Max 7 joueurs (laisse 1 place)

// Smart distribution
const JOBID_LOCK_TTL = 90 * 1000;     // Lock JobID: 90s
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;  // History bot: 6h
const POOL_TTL = 3 * 60 * 1000;       // Pool refresh: 3min

// ═══════════════════════════════════════════════════════════════
//                    STATE (en mémoire)
// ═══════════════════════════════════════════════════════════════

// Pool de serveurs disponibles par PLACE_ID
// Format: { jobId → { players, maxPlayers, addedAt } }
const pools = {
    [PLACES.REBIRTH_0]: new Map(),
    [PLACES.REBIRTH_1_PLUS]: new Map()
};

// Locks de JobIDs (réservés temporairement)
// Format: jobId → { botName, lockedAt }
const jobLocks = new Map();

// Historique par bot
// Format: botName → Map(jobId → visitedAt)
const botHistory = new Map();

// Stats globales
const stats = {
    startedAt: Date.now(),
    totalRequests: 0,
    successfulAssignments: 0,
    rejectedNoServers: 0,
    rejectedAllVisited: 0,
    rejectedAllLocked: 0,
    scansCompleted: 0,
    scansFailed: 0
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
            
            // Filtre: 6 ou 7 joueurs (laisse 1-2 places)
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
    
    // Cleanup: supprimer serveurs trop vieux
    const now = Date.now();
    for (const [jobId, info] of pool.entries()) {
        if (now - info.addedAt > POOL_TTL) {
            pool.delete(jobId);
        }
    }
    
    stats.scansCompleted++;
    console.log(`[SCAN] ${placeId.slice(0, 8)}... → ${totalServers} serveurs (pool size: ${pool.size}, pages: ${pages})`);
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
//                    CLEANUP LOOP
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
    
    if (cleaned > 0) {
        console.log(`[CLEANUP] ${cleaned} locks expirés`);
    }
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
        
        if (history.size === 0) {
            botHistory.delete(botName);
        }
    }
    
    if (totalCleaned > 0) {
        console.log(`[CLEANUP] ${totalCleaned} entrées d'historique expirées`);
    }
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
    
    // Récupérer l'historique du bot
    let history = botHistory.get(botName);
    if (!history) {
        history = new Map();
        botHistory.set(botName, history);
    }
    
    // Construire la liste des JobIDs disponibles
    const availableJobs = [];
    
    for (const [jobId, info] of pool.entries()) {
        // Skip si lock par un autre bot
        const lock = jobLocks.get(jobId);
        if (lock && lock.botName !== botName) {
            continue;
        }
        
        // Skip si déjà visité par CE bot
        if (history.has(jobId)) {
            continue;
        }
        
        availableJobs.push({ jobId, info });
    }
    
    if (availableJobs.length === 0) {
        // Diagnostic plus précis
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
    
    // Prendre un random parmi les disponibles
    const selected = availableJobs[Math.floor(Math.random() * availableJobs.length)];
    
    // Lock + ajouter à l'historique
    jobLocks.set(selected.jobId, {
        botName: botName,
        lockedAt: Date.now()
    });
    
    history.set(selected.jobId, Date.now());
    
    stats.successfulAssignments++;
    
    console.log(`[ASSIGN] ${botName} → ${selected.jobId.slice(0, 12)}... (${selected.info.players}/${selected.info.maxPlayers}) | Pool: ${pool.size} | History: ${history.size}`);
    
    return {
        jobId: selected.jobId,
        players: selected.info.players,
        maxPlayers: selected.info.maxPlayers
    };
}

// ═══════════════════════════════════════════════════════════════
//                    ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// MAIN ENDPOINT - Demande de JobID
app.get('/jobs', (req, res) => {
    stats.totalRequests++;
    
    const { placeId, key } = req.query;
    const botName = req.headers.username || 'anonymous';
    
    // Validation API key
    if (key !== API_KEY) {
        return res.status(401).send('Unauthorized');
    }
    
    // Validation placeId
    if (!placeId || !pools[placeId]) {
        return res.status(400).send('Invalid placeId');
    }
    
    // Get JobID
    const result = getJobIdForBot(placeId, botName);
    
    if (result.error) {
        return res.status(503).send(result.message);
    }
    
    // Retourner JUSTE le JobID en plain text (compatibilité Lua)
    res.type('text/plain').send(result.jobId);
});

// REPORT FAILED - Bot signale qu'un JobID a échoué
app.post('/report-failed', express.json(), (req, res) => {
    const { jobId, key } = req.body;
    const botName = req.headers.username || 'anonymous';
    
    if (key !== API_KEY) {
        return res.status(401).send('Unauthorized');
    }
    
    if (!jobId) {
        return res.status(400).send('Missing jobId');
    }
    
    // Retirer du pool ET du lock
    for (const placeId of Object.keys(pools)) {
        pools[placeId].delete(jobId);
    }
    jobLocks.delete(jobId);
    
    console.log(`[FAILED] ${botName} signale échec sur ${jobId.slice(0, 12)}...`);
    res.send('OK');
});

// STATS - Statistiques globales
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
        stats: {
            totalRequests: stats.totalRequests,
            successful: stats.successfulAssignments,
            rejectedNoServers: stats.rejectedNoServers,
            rejectedAllVisited: stats.rejectedAllVisited,
            rejectedAllLocked: stats.rejectedAllLocked,
            scansCompleted: stats.scansCompleted,
            scansFailed: stats.scansFailed
        }
    });
});

// BOTS - Voir tous les bots et leurs serveurs visités
app.get('/bots', (req, res) => {
    const bots = [];
    
    for (const [botName, history] of botHistory.entries()) {
        // Trouver le dernier JobID visité
        let lastJobId = null;
        let lastVisitedAt = 0;
        
        for (const [jobId, visitedAt] of history.entries()) {
            if (visitedAt > lastVisitedAt) {
                lastVisitedAt = visitedAt;
                lastJobId = jobId;
            }
        }
        
        // Vérifier si actuellement locked
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

// HEALTH
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

// POOL DEBUG - Voir le contenu du pool
app.get('/pool', (req, res) => {
    const { key } = req.query;
    
    if (key !== API_KEY) {
        return res.status(401).send('Unauthorized');
    }
    
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

// ROOT
app.get('/', (req, res) => {
    res.json({
        service: 'JobID Scanner - Smart Distribution',
        endpoints: [
            'GET /jobs?placeId=X&key=Y (header: username)',
            'GET /stats',
            'GET /bots',
            'GET /pool?key=Y',
            'GET /health',
            'POST /report-failed'
        ]
    });
});

// ═══════════════════════════════════════════════════════════════
//                    START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`🚀 JobID Scanner running on port ${PORT}`);
    console.log(`📊 Smart Distribution actif:`);
    console.log(`   - Lock JobID: ${JOBID_LOCK_TTL / 1000}s`);
    console.log(`   - History bot: ${BOT_HISTORY_TTL / 3600 / 1000}h`);
    console.log(`   - Cible: ${MIN_PLAYERS}-${MAX_PLAYERS} joueurs/8`);
    console.log(`   - Scan: toutes les ${SCAN_INTERVAL / 1000}s`);
    
    // Lancer le scanner en background
    scannerLoop();
});
