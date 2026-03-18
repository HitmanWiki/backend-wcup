/**
 * World Cup 2026 Betting — Backend API
 * Fetches matches from API, caches in Neon DB
 * Next requests served from DB
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");
const AIMatchAgent = require("./ai-match-agent.js");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Environment ────────────────────────────────────────────────────────
const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!FOOTBALL_API_KEY) {
  console.error("❌ FOOTBALL_API_KEY missing");
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY missing");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

// ─── PostgreSQL Connection ─────────────────────────────────────────────
const pool = new Pool({ 
  connectionString: DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ DB connection error:", err.stack);
  } else {
    console.log("✅ Connected to Neon PostgreSQL");
    release();
  }
});

const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error("❌ Query error:", err.message);
    throw err;
  }
};

// ─── Initialize database tables ────────────────────────────────────────
async function initDatabase() {
  // Main matches table (cached from API)
  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      start_time BIGINT NOT NULL,
      status TEXT DEFAULT 'SCHEDULED',
      home_score INTEGER DEFAULT 0,
      away_score INTEGER DEFAULT 0,
      winner TEXT,
      competition_code TEXT,
      competition_name TEXT,
      season TEXT,
      matchday INTEGER,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

  // Create indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(start_time);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_teams ON matches(home_team, away_team);`);

  const count = await query("SELECT COUNT(*) FROM matches");
  console.log(`✅ DB ready — ${count.rows[0].count} cached matches`);
  return parseInt(count.rows[0].count);
}

// ─── Football API ──────────────────────────────────────────────────────
const API_BASE = "https://api.football-data.org/v4";
const API_HEADERS = { "X-Auth-Token": FOOTBALL_API_KEY };

const TEAM_NAME_MAP = {
  "United States": "USA",
  "Korea Republic": "South Korea",
  "IR Iran": "Iran",
  "Côte d'Ivoire": "Ivory Coast"
};

const normalizeTeam = (name) => TEAM_NAME_MAP[name] || name;

// ─── Fetch from API and store in DB ────────────────────────────────────
async function fetchAndCacheMatches() {
  console.log("🌍 Fetching fresh matches from API...");
  
  try {
    // Try World Cup first
    let matches = [];
    let source = null;
    
    // Try WC competition
    try {
      const wcResp = await axios.get(
        `${API_BASE}/competitions/WC/matches`,
        { headers: API_HEADERS, timeout: 10000 }
      );
      
      if (wcResp.data.matches?.length > 0) {
        matches = wcResp.data.matches;
        source = "World Cup";
        console.log(`✅ Found ${matches.length} World Cup matches`);
      }
    } catch (wcErr) {
      console.log("⚠️ No World Cup data available, trying other competitions...");
    }
    
    // If no WC matches, try other major tournaments
    if (matches.length === 0) {
      const otherComps = ['CL', 'PL', 'PD', 'BL1', 'SA', 'FL1'];
      
      for (const comp of otherComps) {
        try {
          const resp = await axios.get(
            `${API_BASE}/competitions/${comp}/matches?status=SCHEDULED,FINISHED,IN_PLAY&limit=50`,
            { headers: API_HEADERS, timeout: 5000 }
          );
          
          if (resp.data.matches?.length > 0) {
            matches = resp.data.matches.slice(0, 100); // Limit to 100 matches
            source = comp;
            console.log(`✅ Found ${matches.length} matches from ${comp}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
    }
    
    if (matches.length === 0) {
      console.log("⚠️ No matches found from any API source");
      return 0;
    }
    
    // Store matches in DB
    let stored = 0;
    for (const m of matches) {
      const homeTeam = normalizeTeam(m.homeTeam?.name || "TBD");
      const awayTeam = normalizeTeam(m.awayTeam?.name || "TBD");
      const startTime = Math.floor(new Date(m.utcDate).getTime() / 1000);
      const status = m.status || "SCHEDULED";
      const homeScore = m.score?.fullTime?.home ?? 0;
      const awayScore = m.score?.fullTime?.away ?? 0;
      const season = m.season?.startDate?.split('-')[0] || "2026";
      
      const winner = status === "FINISHED" && homeScore !== awayScore
        ? (homeScore > awayScore ? homeTeam : awayTeam)
        : null;

      try {
        await query(
          `INSERT INTO matches 
           (id, home_team, away_team, start_time, status, home_score, away_score, winner, 
            competition_code, competition_name, season, matchday)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            home_score = EXCLUDED.home_score,
            away_score = EXCLUDED.away_score,
            winner = EXCLUDED.winner,
            last_updated = CURRENT_TIMESTAMP`,
          [
            m.id, homeTeam, awayTeam, startTime, status,
            homeScore, awayScore, winner,
            m.competition?.code || 'INTL',
            m.competition?.name || 'International',
            season, m.matchday
          ]
        );
        stored++;
      } catch (e) {
        console.error(`❌ Error storing match ${m.id}:`, e.message);
      }
    }
    
    // Update cache metadata
    await query(
      `INSERT INTO cache_metadata (key, last_fetched, data_hash)
       VALUES ('matches', NOW(), $1)
       ON CONFLICT (key) DO UPDATE SET
        last_fetched = NOW(),
        data_hash = EXCLUDED.data_hash`,
      [String(matches.length)]
    );
    
    console.log(`✅ Cached ${stored} matches in DB (source: ${source})`);
    return stored;
    
  } catch (err) {
    console.error("❌ API fetch failed:", err.message);
    return 0;
  }
}

// ─── AI Agent ───────────────────────────────────────────────────────────
const aiAgent = new AIMatchAgent({
  geminiApiKey: GEMINI_API_KEY
});
console.log("✅ AI Agent ready (uses Google Search)");

// ─── Format match for frontend ─────────────────────────────────────────
function formatMatch(row) {
  // Mock pools/odds for demo
  const homePool = Math.floor(Math.random() * 100) + 50;
  const drawPool = Math.floor(Math.random() * 50) + 20;
  const awayPool = Math.floor(Math.random() * 80) + 40;
  const totalPool = homePool + drawPool + awayPool;
  
  return {
    id: row.id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    startTime: row.start_time,
    status: row.status,
    competition: {
      code: row.competition_code,
      name: row.competition_name
    },
    score: { home: row.home_score, away: row.away_score },
    winner: row.winner,
    // Mock data for frontend
    pools: {
      home: homePool.toString(),
      draw: drawPool.toString(),
      away: awayPool.toString(),
      total: totalPool.toString()
    },
    odds: {
      home: Number(((homePool / totalPool) * 100).toFixed(2)),
      draw: Number(((drawPool / totalPool) * 100).toFixed(2)),
      away: Number(((awayPool / totalPool) * 100).toFixed(2))
    },
    bettingOpen: ["SCHEDULED", "TIMED", "IN_PLAY"].includes(row.status)
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "World Cup 2026 API",
    version: "1.0.0",
    description: "Matches cached in Neon DB | AI uses Google Search",
    endpoints: {
      matches: "GET /api/matches (from DB cache)",
      match: "GET /api/matches/:id",
      refresh: "POST /api/refresh (fetch fresh from API)",
      analyze: "GET /api/analyze?home=Brazil&away=Argentina",
      ai: {
        gemini: "GET /api/ai/gemini/:matchId",
        predict: "GET /api/ai/predict?home=X&away=Y"
      },
      stats: "GET /api/stats",
      leaderboard: "GET /api/leaderboard",
      ultimate: "GET /api/ultimate",
      cache: "GET /api/cache/info"
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  const count = await query("SELECT COUNT(*) FROM matches");
  res.json({
    status: "ok",
    matchesInDB: parseInt(count.rows[0].count),
    aiAgent: "active",
    timestamp: new Date().toISOString()
  });
});

// ─── MATCHES (served from DB cache) ────────────────────────────────────

// GET /api/matches - Get all cached matches
app.get("/api/matches", async (req, res) => {
  try {
    const result = await query("SELECT * FROM matches ORDER BY start_time ASC");
    const matches = result.rows.map(formatMatch);
    
    res.json({ 
      matches,
      total: matches.length,
      source: "Database cache",
      cacheDate: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matches/:id - Get specific match
app.get("/api/matches/:id", async (req, res) => {
  try {
    const result = await query("SELECT * FROM matches WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }
    res.json({ match: formatMatch(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI ENDPOINTS ──────────────────────────────────────────────────────

// GET /api/analyze - Analyze any two teams (agent searches Google)
app.get("/api/analyze", async (req, res) => {
  const { home, away, competition } = req.query;
  
  if (!home || !away) {
    return res.status(400).json({ 
      error: "Please provide home and away team names" 
    });
  }

  try {
    console.log(`🔍 Agent researching: ${home} vs ${away}`);
    
    const analysis = await aiAgent.predict(home, away, {
      competition: competition || "FIFA World Cup 2026"
    });

    res.json(analysis);
  } catch (err) {
    console.error("❌ Analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/gemini/:matchId - Analyze match from DB
app.get("/api/ai/gemini/:matchId", async (req, res) => {
  try {
    const match = await query("SELECT * FROM matches WHERE id = $1", [req.params.matchId]);
    
    if (match.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }
    
    const m = match.rows[0];
    
    const analysis = await aiAgent.predict(m.home_team, m.away_team, {
      competition: m.competition_name || "FIFA World Cup 2026"
    });

    res.json({
      matchId: m.id,
      ...analysis,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/predict - Alias for analyze
app.get("/api/ai/predict", async (req, res) => {
  const { home, away, competition } = req.query;
  
  if (!home || !away) {
    return res.status(400).json({ error: "Please provide home and away" });
  }

  const analysis = await aiAgent.predict(home, away, {
    competition: competition || "FIFA World Cup 2026"
  });
  
  res.json(analysis);
});

// ─── REFRESH ENDPOINT - Fetch fresh from API and update cache ──────────
app.post("/api/refresh", async (req, res) => {
  try {
    const stored = await fetchAndCacheMatches();
    const total = await query("SELECT COUNT(*) FROM matches");
    const cacheInfo = await query("SELECT * FROM cache_metadata WHERE key = 'matches'");
    
    res.json({
      success: true,
      newMatches: stored,
      totalMatches: parseInt(total.rows[0].count),
      lastUpdated: cacheInfo.rows[0]?.last_fetched || null,
      message: stored > 0 ? `Cached ${stored} new matches` : "No new matches"
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── CACHE INFO ────────────────────────────────────────────────────────
app.get("/api/cache/info", async (req, res) => {
  const cacheInfo = await query("SELECT * FROM cache_metadata WHERE key = 'matches'");
  const matchCount = await query("SELECT COUNT(*) FROM matches");
  
  res.json({
    cacheExists: cacheInfo.rows.length > 0,
    lastFetched: cacheInfo.rows[0]?.last_fetched || null,
    matchesInDB: parseInt(matchCount.rows[0].count),
    note: "Matches are served from DB cache. Use POST /api/refresh to update."
  });
});

// ─── MOCK ENDPOINTS (for frontend) ─────────────────────────────────────

// GET /api/stats
app.get("/api/stats", async (req, res) => {
  const count = await query("SELECT COUNT(*) FROM matches");
  
  res.json({
    matchCount: parseInt(count.rows[0].count),
    liveMatches: 0,
    finishedMatches: 0,
    totalVolumeCLUTCH: "125000",
    uniqueUsers: 1243,
    totalBets: 5678,
    note: "Real match counts from DB cache"
  });
});

// GET /api/leaderboard
app.get("/api/leaderboard", (req, res) => {
  res.json({
    leaderboard: [
      { user: "0x1234...5678", total_wagered: "50000", bet_count: 23 },
      { user: "0x2345...6789", total_wagered: "45000", bet_count: 19 }
    ],
    note: "MOCK data for demo"
  });
});

// GET /api/ultimate
app.get("/api/ultimate", (req, res) => {
  res.json({
    deadline: Math.floor(Date.now() / 1000) + 2592000,
    settled: false,
    winner: null,
    totalPool: "168000",
    teamPools: [
      { team: "Brazil", amount: "45000" },
      { team: "Argentina", amount: "38000" }
    ],
    note: "MOCK data for demo"
  });
});

// ─── Initialize and Start ──────────────────────────────────────────────
async function start() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 World Cup 2026 API (Cached Mode)");
  console.log("=".repeat(60));
  
  const matchCount = await initDatabase();
  
  // If DB is empty, fetch from API on startup
  if (matchCount === 0) {
    console.log("\n🔄 First run - fetching matches from API...");
    await fetchAndCacheMatches();
  } else {
    console.log(`\n📊 Using ${matchCount} cached matches from DB`);
  }
  
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`📊 Matches: served from DB cache`);
    console.log(`🔄 Refresh: POST /api/refresh to update cache`);
    console.log(`🤖 AI Agent: Gemini with Google Search`);
    console.log("=".repeat(60) + "\n");
  });
}

start().catch(console.error);