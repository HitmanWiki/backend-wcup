/**
 * World Cup 2026 Betting — Backend API
 * ONLY fetches World Cup matches from API → caches in Neon DB
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const { Pool } = require("pg");
const AIMatchAgent = require("./ai-match-agent.js");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Env ─────────────────────────────────────────────────────────────────────
const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const DATABASE_URL     = process.env.DATABASE_URL;

if (!GEMINI_API_KEY) { 
  console.error("❌ GEMINI_API_KEY missing");  
  process.exit(1); 
}
if (!DATABASE_URL)   { 
  console.error("❌ DATABASE_URL missing");     
  process.exit(1); 
}
if (!FOOTBALL_API_KEY) {
  console.warn("⚠️ FOOTBALL_API_KEY missing — cannot fetch matches");
}

// ─── PostgreSQL with proper SSL ───────────────────────────────────────────────
const pool = new Pool({ 
  connectionString: DATABASE_URL, 
  ssl: { 
    rejectUnauthorized: true,
    sslmode: 'require'
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20
});

pool.on('error', (err) => {
  console.error('❌ Unexpected pool error:', err);
});

async function testConnection() {
  let retries = 3;
  while (retries > 0) {
    try {
      const client = await pool.connect();
      console.log("✅ Connected to Neon PostgreSQL");
      client.release();
      return true;
    } catch (err) {
      retries--;
      console.log(`⚠️ Connection attempt failed (${retries} retries left):`, err.message);
      if (retries === 0) {
        console.error("❌ Failed to connect to database after 3 attempts");
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return false;
}

const query = async (text, params) => {
  try { 
    return await pool.query(text, params); 
  }
  catch (err) { 
    console.error("❌ Query error:", err.message); 
    throw err; 
  }
};

// ─── DB init ──────────────────────────────────────────────────────────────────
async function initDatabase() {
  try {
    const connected = await testConnection();
    if (!connected) {
      console.log("⚠️ Continuing without database connection");
      return 0;
    }
    
    // Main matches table (only World Cup matches)
    await query(`
      CREATE TABLE IF NOT EXISTS matches (
        id               INTEGER   PRIMARY KEY,
        home_team        TEXT      NOT NULL,
        away_team        TEXT      NOT NULL,
        start_time       BIGINT    NOT NULL,
        status           TEXT      DEFAULT 'SCHEDULED',
        home_score       INTEGER   DEFAULT 0,
        away_score       INTEGER   DEFAULT 0,
        winner           TEXT,
        competition_code TEXT,
        competition_name TEXT,
        stage            TEXT,
        group_name       TEXT,
        matchday         INTEGER,
        last_updated     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Cache metadata table
    await query(`
      CREATE TABLE IF NOT EXISTS cache_metadata (
        key TEXT PRIMARY KEY, 
        last_fetched TIMESTAMP, 
        data_hash TEXT
      );
    `);

    // AI predictions cache
    await query(`
      CREATE TABLE IF NOT EXISTS ai_predictions (
        cache_key  TEXT      PRIMARY KEY,
        prediction JSONB     NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      );
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(start_time);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_matches_teams ON matches(home_team, away_team);`);

    const count = parseInt((await query("SELECT COUNT(*) FROM matches")).rows[0].count);
    console.log(`✅ DB ready — ${count} World Cup matches cached`);
    return count;
    
  } catch (err) {
    console.error("❌ Database initialization failed:", err.message);
    return 0;
  }
}

// ─── Football API ─────────────────────────────────────────────────────────────
const API_BASE    = "https://api.football-data.org/v4";
const API_HEADERS = FOOTBALL_API_KEY ? { "X-Auth-Token": FOOTBALL_API_KEY } : null;

const TEAM_MAP = {
  "United States" : "USA",
  "Korea Republic": "South Korea",
  "IR Iran"       : "Iran",
  "Côte d'Ivoire" : "Ivory Coast",
};
const normalizeTeam = (n) => TEAM_MAP[n] || n;

// ─── Fetch ONLY World Cup matches from API ────────────────────────────────────
async function fetchWorldCupMatches() {
  if (!FOOTBALL_API_KEY || !API_HEADERS) {
    console.log("⚠️ No FOOTBALL_API_KEY — skipping fetch");
    return 0;
  }
  
  console.log("🌍 Fetching World Cup matches from API...");

  try {
    const resp = await axios.get(
      `${API_BASE}/competitions/WC/matches`,
      { headers: API_HEADERS, timeout: 10000 }
    );
    
    if (!resp.data.matches?.length) {
      console.log("⚠️ No World Cup matches found in API");
      return 0;
    }

    const matches = resp.data.matches;
    console.log(`✅ Found ${matches.length} World Cup matches`);

    let stored = 0;
    for (const m of matches) {
      const homeTeam  = normalizeTeam(m.homeTeam?.name || "TBD");
      const awayTeam  = normalizeTeam(m.awayTeam?.name || "TBD");
      const startTime = Math.floor(new Date(m.utcDate).getTime() / 1000);
      const status    = m.status || "SCHEDULED";
      const homeScore = m.score?.fullTime?.home ?? 0;
      const awayScore = m.score?.fullTime?.away ?? 0;
      const winner    = status === "FINISHED" && homeScore !== awayScore
        ? (homeScore > awayScore ? homeTeam : awayTeam) : null;

      try {
        await query(
          `INSERT INTO matches
           (id, home_team, away_team, start_time, status, home_score, away_score,
            winner, competition_code, competition_name, stage, group_name, matchday)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             home_score = EXCLUDED.home_score,
             away_score = EXCLUDED.away_score,
             winner = EXCLUDED.winner,
             last_updated = CURRENT_TIMESTAMP`,
          [
            m.id, homeTeam, awayTeam, startTime, status, homeScore, awayScore,
            winner, 
            m.competition?.code || "WC", 
            m.competition?.name || "FIFA World Cup",
            m.stage || null,
            m.group || null,
            m.matchday || null
          ]
        );
        stored++;
      } catch (e) { 
        console.error(`❌ Error storing match ${m.id}:`, e.message); 
      }
    }

    await query(
      `INSERT INTO cache_metadata (key, last_fetched, data_hash)
       VALUES ('worldcup', NOW(), $1)
       ON CONFLICT (key) DO UPDATE SET 
         last_fetched = NOW(), 
         data_hash = EXCLUDED.data_hash`,
      [String(stored)]
    );
    
    console.log(`✅ Cached ${stored} World Cup matches in DB`);
    return stored;
    
  } catch (err) {
    if (err.response?.status === 404) {
      console.log("⚠️ World Cup competition not found in API");
    } else if (err.response?.status === 429) {
      console.log("⚠️ Rate limited by API — try again later");
    } else {
      console.error("❌ API fetch failed:", err.message);
    }
    return 0;
  }
}

// Auto-refresh every 6 hours
function scheduleAutoRefresh() {
  setInterval(async () => {
    console.log("\n🔄 Auto-refreshing World Cup matches...");
    try { 
      await fetchWorldCupMatches(); 
    } catch (e) { 
      console.error("❌ Auto-refresh failed:", e.message); 
    }
  }, 6 * 60 * 60 * 1000);
  console.log("⏰ Auto-refresh scheduled every 6 hours");
}

// ─── AI Agent ─────────────────────────────────────────────────────────────────
const aiAgent = new AIMatchAgent({ geminiApiKey: GEMINI_API_KEY });
console.log("🤖 AI Agent ready (Gemini + Google Search)");

// AI prediction cache helpers
async function getCachedPrediction(key) {
  try {
    const r = await query(
      "SELECT prediction FROM ai_predictions WHERE cache_key=$1 AND expires_at > NOW()",
      [key]
    );
    if (r.rows.length > 0) {
      console.log(`💾 Cache hit: ${key}`);
      return { ...r.rows[0].prediction, _fromCache: true };
    }
  } catch { }
  return null;
}

async function savePrediction(key, prediction) {
  try {
    await query(
      `INSERT INTO ai_predictions (cache_key, prediction, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')
       ON CONFLICT (cache_key) DO UPDATE SET
         prediction = EXCLUDED.prediction,
         created_at = NOW(),
         expires_at = NOW() + INTERVAL '30 minutes'`,
      [key, JSON.stringify(prediction)]
    );
  } catch (e) { 
    console.warn("⚠️ AI cache write failed:", e.message); 
  }
}

// ─── Stable random pools (same for each match ID) ────────────────────────────
function stableRandom(seed, min, max) {
  const x = Math.sin(seed) * 10000;
  return Math.floor((x - Math.floor(x)) * (max - min + 1)) + min;
}

function formatMatch(row) {
  const s        = row.id;
  const homePool = stableRandom(s * 1, 50, 150);
  const drawPool = stableRandom(s * 2, 20,  70);
  const awayPool = stableRandom(s * 3, 40, 120);
  const total    = homePool + drawPool + awayPool;
  
  return {
    id          : row.id,
    homeTeam    : row.home_team,
    awayTeam    : row.away_team,
    startTime   : row.start_time,
    status      : row.status,
    competition : { 
      code: row.competition_code, 
      name: row.competition_name 
    },
    stage       : row.stage,
    group       : row.group_name,
    score       : { home: row.home_score, away: row.away_score },
    winner      : row.winner,
    matchday    : row.matchday,
    pools       : {
      home : homePool.toString(),
      draw : drawPool.toString(),
      away : awayPool.toString(),
      total: total.toString(),
    },
    odds        : {
      home : +((homePool / total) * 100).toFixed(2),
      draw : +((drawPool / total) * 100).toFixed(2),
      away : +((awayPool / total) * 100).toFixed(2),
    },
    bettingOpen : ["SCHEDULED", "TIMED", "IN_PLAY"].includes(row.status),
  };
}

// ════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.json({
  name     : "World Cup 2026 API",
  description: "ONLY World Cup matches cached in DB",
  endpoints: {
    matches : "GET  /api/matches (all World Cup matches)",
    match   : "GET  /api/matches/:id",
    analyze : "GET  /api/analyze?home=Brazil&away=Argentina",
    gemini  : "GET  /api/ai/gemini/:matchId",
    predict : "GET  /api/ai/predict?home=X&away=Y",
    stats   : "GET  /api/stats",
    refresh : "POST /api/refresh (fetch latest World Cup matches)",
    cache   : "GET  /api/cache/info",
    health  : "GET  /api/health",
    leaderboard: "GET /api/leaderboard",
    ultimate: "GET /api/ultimate"
  },
}));

app.get("/api/health", async (req, res) => {
  try {
    const r = await query("SELECT COUNT(*) FROM matches");
    res.json({ 
      status: "ok", 
      matchesInDB: parseInt(r.rows[0].count),
      worldCupOnly: true,
      timestamp: new Date().toISOString() 
    });
  } catch { 
    res.json({ status: "ok", matchesInDB: 0 }); 
  }
});

// GET /api/matches - ONLY World Cup matches from DB
app.get("/api/matches", async (req, res) => {
  try {
    const { status, group } = req.query;
    let sql = "SELECT * FROM matches";
    const vals = [];
    const clauses = [];
    
    if (status) { 
      clauses.push(`status = $${vals.length + 1}`); 
      vals.push(status); 
    }
    if (group) { 
      clauses.push(`group_name = $${vals.length + 1}`); 
      vals.push(group); 
    }
    
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY start_time ASC";
    
    const r = await query(sql, vals);
    res.json({ 
      matches: r.rows.map(formatMatch), 
      total: r.rows.length,
      source: "World Cup Database Cache"
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get("/api/matches/:id", async (req, res) => {
  try {
    const r = await query("SELECT * FROM matches WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Match not found" });
    res.json({ match: formatMatch(r.rows[0]) });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// GET /api/stats - Real counts from DB
app.get("/api/stats", async (req, res) => {
  try {
    const [total, live, finished, scheduled] = await Promise.all([
      query("SELECT COUNT(*) FROM matches"),
      query("SELECT COUNT(*) FROM matches WHERE status='IN_PLAY'"),
      query("SELECT COUNT(*) FROM matches WHERE status='FINISHED'"),
      query("SELECT COUNT(*) FROM matches WHERE status IN ('SCHEDULED','TIMED')"),
    ]);
    res.json({
      matchCount       : parseInt(total.rows[0].count),
      liveMatches      : parseInt(live.rows[0].count),
      finishedMatches  : parseInt(finished.rows[0].count),
      scheduledMatches : parseInt(scheduled.rows[0].count),
      note: "Real World Cup match counts from DB"
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// POST /api/refresh - Manually fetch World Cup matches
app.post("/api/refresh", async (req, res) => {
  try {
    const stored = await fetchWorldCupMatches();
    const total  = parseInt((await query("SELECT COUNT(*) FROM matches")).rows[0].count);
    const cache  = await query("SELECT * FROM cache_metadata WHERE key='worldcup'");
    res.json({ 
      success: true, 
      stored, 
      totalMatches: total, 
      lastUpdated: cache.rows[0]?.last_fetched 
    });
  } catch (err) { 
    res.status(500).json({ success: false, error: err.message }); 
  }
});

// GET /api/cache/info - Cache information
app.get("/api/cache/info", async (req, res) => {
  try {
    const [cache, count, aiCount] = await Promise.all([
      query("SELECT * FROM cache_metadata WHERE key='worldcup'"),
      query("SELECT COUNT(*) FROM matches"),
      query("SELECT COUNT(*) FROM ai_predictions WHERE expires_at > NOW()"),
    ]);
    res.json({
      lastFetched       : cache.rows[0]?.last_fetched || null,
      matchesInDB       : parseInt(count.rows[0].count),
      activePredictions : parseInt(aiCount.rows[0].count),
      autoRefresh       : "every 6 hours",
      source            : "World Cup only"
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ─── AI endpoints ─────────────────────────────────────────────────────────────

// GET /api/analyze - Analyze any two teams (agent searches Google)
app.get("/api/analyze", async (req, res) => {
  const { home, away, competition } = req.query;
  if (!home || !away) return res.status(400).json({ error: "Provide home and away" });
  
  const key = `predict:${home.toLowerCase()}:${away.toLowerCase()}`;
  try {
    const cached = await getCachedPrediction(key);
    if (cached) return res.json(cached);
    
    console.log(`🔍 Gemini researching: ${home} vs ${away}`);
    const result = await aiAgent.predict(home, away, { 
      competition: competition || "FIFA World Cup 2026" 
    });
    
    await savePrediction(key, result);
    res.json(result);
  } catch (err) { 
    console.error("❌ /api/analyze error:", err); 
    res.status(500).json({ error: err.message }); 
  }
});

// GET /api/ai/gemini/:matchId - Analyze match from DB
app.get("/api/ai/gemini/:matchId", async (req, res) => {
  try {
    const r = await query("SELECT * FROM matches WHERE id=$1", [req.params.matchId]);
    if (!r.rows.length) return res.status(404).json({ error: "Match not found" });
    
    const m   = r.rows[0];
    const key = `predict:${m.home_team.toLowerCase()}:${m.away_team.toLowerCase()}`;
    
    const cached = await getCachedPrediction(key);
    if (cached) return res.json({ matchId: m.id, ...cached });
    
    console.log(`🤖 Gemini analyzing: ${m.home_team} vs ${m.away_team}`);
    const result = await aiAgent.predict(m.home_team, m.away_team, { 
      competition: m.competition_name || "FIFA World Cup 2026" 
    });
    
    await savePrediction(key, result);
    res.json({ 
      matchId: m.id, 
      ...result, 
      timestamp: new Date().toISOString() 
    });
  } catch (err) { 
    console.error("❌ /api/ai/gemini error:", err); 
    res.status(500).json({ error: err.message }); 
  }
});

// GET /api/ai/predict - Alias for analyze
app.get("/api/ai/predict", async (req, res) => {
  const { home, away, competition } = req.query;
  if (!home || !away) return res.status(400).json({ error: "Provide home and away" });
  
  const key = `predict:${home.toLowerCase()}:${away.toLowerCase()}`;
  try {
    const cached = await getCachedPrediction(key);
    if (cached) return res.json(cached);
    
    const result = await aiAgent.predict(home, away, { 
      competition: competition || "FIFA World Cup 2026" 
    });
    
    await savePrediction(key, result);
    res.json(result);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ─── Mock endpoints for frontend ─────────────────────────────────────────────

app.get("/api/leaderboard", (req, res) => res.json({
  leaderboard: [
    { user: "0x1234...5678", total_wagered: "50000", bet_count: 23 },
    { user: "0x2345...6789", total_wagered: "45000", bet_count: 19 },
    { user: "0x3456...7890", total_wagered: "38000", bet_count: 31 },
  ],
  note: "MOCK data for demo"
}));

app.get("/api/ultimate", (req, res) => res.json({
  deadline: Math.floor(Date.now()/1000) + 2592000, 
  settled: false, 
  winner: null,
  totalPool: "168000",
  teamPools: [
    { team:"Brazil", amount:"45000" },
    { team:"Argentina", amount:"38000" },
    { team:"France", amount:"32000" }
  ],
  note: "MOCK data for demo"
}));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log("=".repeat(55));
  console.log("🌍 World Cup 2026 API");
  console.log("=".repeat(55));

  const matchCount = await initDatabase();

  if (matchCount === 0) {
    console.log("🔄 Empty DB — fetching World Cup matches from API...");
    await fetchWorldCupMatches();
  } else {
    console.log(`📊 Serving ${matchCount} World Cup matches from DB cache`);
  }

  scheduleAutoRefresh();

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`⚽ Matches  : GET /api/matches (World Cup only)`);
    console.log(`🤖 Analyze  : GET /api/analyze?home=Brazil&away=Argentina`);
    console.log(`🔄 Refresh  : POST /api/refresh`);
    console.log("=".repeat(55));
  });
}

start().catch(console.error);
module.exports = app;