/**
 * World Cup 2026 Betting — Backend API
 * Simple server that:
 * - Serves matches from Neon DB
 * - Connects to AI agent (which does its own Google search)
 * - Provides mock endpoints for frontend
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const AIMatchAgent = require("./ai-match-agent.js");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Environment ────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

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

// ─── Initialize matches table ──────────────────────────────────────────
async function initDatabase() {
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
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  const count = await query("SELECT COUNT(*) FROM matches");
  console.log(`✅ DB ready — ${count.rows[0].count} matches`);
}

// ─── AI Agent ──────────────────────────────────────────────────────────
const aiAgent = new AIMatchAgent({
  geminiApiKey: GEMINI_API_KEY
});
console.log("✅ AI Agent ready (uses Google Search)");

// ─── Helper: Format match for frontend ─────────────────────────────────
function formatMatch(row) {
  // Mock pools/odds for demo (as you wanted)
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
    score: { 
      home: row.home_score, 
      away: row.away_score 
    },
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
    status: "running",
    aiAgent: "Gemini with Google Search",
    endpoints: {
      matches: "GET /api/matches",
      match: "GET /api/matches/:id",
      analyze: "GET /api/analyze?home=Brazil&away=Argentina",
      ai: {
        gemini: "GET /api/ai/gemini/:matchId",
        predict: "GET /api/ai/predict?home=X&away=Y"
      },
      leaderboard: "GET /api/leaderboard",
      ultimate: "GET /api/ultimate",
      stats: "GET /api/stats",
      health: "GET /api/health"
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const count = await query("SELECT COUNT(*) FROM matches");
    res.json({
      status: "ok",
      matchesInDB: parseInt(count.rows[0].count),
      aiAgent: "active",
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.json({ status: "ok", matchesInDB: 0 });
  }
});

// ─── MATCHES (from your Neon DB) ───────────────────────────────────────

// GET /api/matches - All matches
app.get("/api/matches", async (req, res) => {
  try {
    const result = await query("SELECT * FROM matches ORDER BY start_time ASC");
    const matches = result.rows.map(formatMatch);
    
    res.json({ 
      matches,
      total: matches.length,
      source: "Your Neon Database"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matches/:id - Single match
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

// ─── AI ENDPOINTS (agent does its own Google search) ───────────────────

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

    res.json({
      ...analysis,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("❌ Analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/predict - Alias for /analyze
app.get("/api/ai/predict", async (req, res) => {
  const { home, away, competition } = req.query;
  
  if (!home || !away) {
    return res.status(400).json({ 
      error: "Please provide home and away team names" 
    });
  }

  try {
    const analysis = await aiAgent.predict(home, away, {
      competition: competition || "FIFA World Cup 2026"
    });

    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/gemini/:matchId - Analyze a specific match from DB
app.get("/api/ai/gemini/:matchId", async (req, res) => {
  try {
    // Get match from DB
    const match = await query("SELECT * FROM matches WHERE id = $1", [req.params.matchId]);
    
    if (match.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }
    
    const m = match.rows[0];
    
    // Let agent research these teams
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

// ─── MOCK ENDPOINTS (for frontend) ─────────────────────────────────────

// GET /api/stats
app.get("/api/stats", async (req, res) => {
  try {
    const count = await query("SELECT COUNT(*) FROM matches");
    
    res.json({
      matchCount: parseInt(count.rows[0].count),
      liveMatches: 0,
      finishedMatches: 0,
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678,
      note: "Real match counts from DB, mock betting data"
    });
  } catch (err) {
    res.json({
      matchCount: 0,
      liveMatches: 0,
      finishedMatches: 0,
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678
    });
  }
});

// GET /api/leaderboard
app.get("/api/leaderboard", (req, res) => {
  res.json({
    leaderboard: [
      { user: "0x1234...5678", total_wagered: "50000", bet_count: 23 },
      { user: "0x2345...6789", total_wagered: "45000", bet_count: 19 },
      { user: "0x3456...7890", total_wagered: "38000", bet_count: 31 },
      { user: "0x4567...8901", total_wagered: "29000", bet_count: 15 },
      { user: "0x5678...9012", total_wagered: "21000", bet_count: 12 }
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
      { team: "Argentina", amount: "38000" },
      { team: "France", amount: "32000" },
      { team: "Germany", amount: "28000" },
      { team: "England", amount: "25000" }
    ],
    note: "MOCK data for demo"
  });
});

// ─── ADMIN: Refresh matches (if you need to update DB) ─────────────────
app.post("/api/refresh", async (req, res) => {
  // This is where you'd add logic to fetch matches if needed
  // For now, just return current count
  const count = await query("SELECT COUNT(*) FROM matches");
  res.json({ 
    success: true, 
    message: "Matches endpoint working",
    matchesInDB: parseInt(count.rows[0].count)
  });
});

// ─── Initialize and Start ──────────────────────────────────────────────
async function start() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 World Cup 2026 API");
  console.log("=".repeat(60));
  
  await initDatabase();
  
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`📊 Matches: from Neon DB`);
    console.log(`🤖 AI Agent: Gemini with Google Search`);
    console.log("=".repeat(60) + "\n");
  });
}

start().catch(console.error);