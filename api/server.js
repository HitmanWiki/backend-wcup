/**
 * World Cup 2026 Betting — Backend API
 * Matches: ONLY real World Cup data from API
 * Other data: MOCK for demo (pools, odds, leaderboard, ultimate)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require('pg');
const AIMatchAgent = require('./ai-match-agent.js');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const isVercel = process.env.VERCEL === '1';

if (!FOOTBALL_API_KEY) {
  console.error("❌ FATAL: FOOTBALL_DATA_API_KEY not found in environment");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("❌ FATAL: DATABASE_URL not found in environment");
  process.exit(1);
}

// ─── Neon PostgreSQL Connection ───────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error connecting to Neon:', err.stack);
  } else {
    console.log('✅ Connected to Neon PostgreSQL');
    release();
  }
});

const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    console.log('📊 Query:', { text: text.substring(0, 50) + '...', duration: Date.now() - start, rows: res.rowCount });
    return res;
  } catch (err) {
    console.error('❌ Query error:', err.message);
    throw err;
  }
};

// Initialize database tables
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
  
  console.log("✅ Database tables initialized");
  const result = await query("SELECT COUNT(*) FROM matches");
  const count = parseInt(result.rows[0].count);
  console.log(`📊 Current matches in DB: ${count}`);
  return count;
}

// ─── Football-Data.org API ─────────────────────────────────────────────────
const API_BASE = "https://api.football-data.org/v4";
const API_HEADERS = { "X-Auth-Token": FOOTBALL_API_KEY };

// Initialize Gemini AI Agent (if API key exists)
let aiAgent = null;
if (GEMINI_API_KEY) {
  try {
    aiAgent = new AIMatchAgent({
      geminiApiKey: GEMINI_API_KEY,
      footballApiKey: FOOTBALL_API_KEY,
      newsApiKey: NEWS_API_KEY
    });
    console.log("✅ Gemini AI Agent initialized");
  } catch (error) {
    console.error("❌ Failed to initialize Gemini AI Agent:", error.message);
  }
}

// ─── Helper: Normalize team names ─────────────────────────────────────────
function normalizeTeam(name) {
  const map = {
    "United States": "USA",
    "Korea Republic": "South Korea",
    "IR Iran": "Iran",
    "Côte d'Ivoire": "Ivory Coast"
  };
  return map[name] || name;
}

// ─── Fetch ONLY World Cup matches from API ───────────────────────────────
async function fetchWorldCupMatches() {
  console.log("🌍 Fetching World Cup matches from API...");
  
  try {
    const response = await axios.get(
      `${API_BASE}/competitions/WC/matches`,
      { headers: API_HEADERS, timeout: 10000 }
    );
    
    const matches = response.data.matches || [];
    console.log(`✅ Found ${matches.length} World Cup matches`);
    return matches;
    
  } catch (error) {
    if (error.response?.status === 404) {
      console.log("⚠️ World Cup competition not found in API");
    } else {
      console.error("❌ Failed to fetch World Cup data:", error.message);
    }
    return [];
  }
}

// ─── Store matches in Neon PostgreSQL ────────────────────────────────────
async function storeMatches(matches) {
  if (matches.length === 0) return 0;
  
  let stored = 0;
  for (const match of matches) {
    const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
    const homeTeam = normalizeTeam(match.homeTeam?.name || "TBD");
    const awayTeam = normalizeTeam(match.awayTeam?.name || "TBD");
    const status = match.status || "SCHEDULED";
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    
    let winner = null;
    if (status === "FINISHED" && homeScore !== awayScore) {
      winner = homeScore > awayScore ? homeTeam : awayTeam;
    }
    
    try {
      await query(
        `INSERT INTO matches 
         (id, home_team, away_team, start_time, status, home_score, away_score, winner, competition_code, competition_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          home_score = EXCLUDED.home_score,
          away_score = EXCLUDED.away_score,
          winner = EXCLUDED.winner,
          last_updated = CURRENT_TIMESTAMP`,
        [match.id, homeTeam, awayTeam, startTime, status, homeScore, awayScore, winner, 'WC', 'FIFA World Cup']
      );
      stored++;
    } catch (e) {
      console.error(`❌ Error storing match ${match.id}:`, e.message);
    }
  }
  
  console.log(`✅ Stored ${stored} matches`);
  return stored;
}

// ─── Format match with MOCK pools/odds ────────────────────────────────────
function formatMatch(row) {
  // MOCK pools and odds (for frontend demo)
  const homePool = Math.floor(Math.random() * 100) + 50;
  const drawPool = Math.floor(Math.random() * 50) + 20;
  const awayPool = Math.floor(Math.random() * 80) + 40;
  const totalPool = homePool + drawPool + awayPool;
  
  const odds = {
    home: Number(((homePool / totalPool) * 100).toFixed(2)),
    draw: Number(((drawPool / totalPool) * 100).toFixed(2)),
    away: Number(((awayPool / totalPool) * 100).toFixed(2))
  };

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
    // MOCK data below
    pools: {
      home: homePool.toString(),
      draw: drawPool.toString(),
      away: awayPool.toString(),
      total: totalPool.toString()
    },
    odds,
    bettingOpen: row.status === "SCHEDULED" || row.status === "TIMED" || row.status === "IN_PLAY"
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  API ENDPOINTS - AI ROUTES FIRST (important for route matching)
// ═══════════════════════════════════════════════════════════════════════

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "World Cup 2026 API",
    description: "Matches: REAL data from API | Pools/Odds: MOCK data for demo",
    status: "running",
    environment: isVercel ? "vercel" : "local",
    database: "Neon PostgreSQL",
    aiStatus: aiAgent ? "✅ Gemini AI Active" : "❌ Gemini AI Not Configured",
    endpoints: {
      health: "/api/health",
      matches: "/api/matches",
      match: "/api/matches/:id",
      stats: "/api/stats",
      leaderboard: "/api/leaderboard",
      ultimate: "/api/ultimate",
      ai: {
        analyze: "/api/ai/analyze/:matchId",
        gemini: "/api/ai/gemini/:matchId",
        head2head: "/api/ai/head2head",
        form: "/api/ai/form/:team",
        predict: "/api/ai/predict"
      },
      refresh: "/api/refresh",
      debug: "/api/debug"
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const result = await query("SELECT COUNT(*) FROM matches");
    const matchCount = parseInt(result.rows[0].count);
    
    res.json({ 
      status: "ok",
      matchesInDB: matchCount,
      database: "Neon PostgreSQL",
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
      geminiKey: GEMINI_API_KEY ? "✅" : "❌",
      note: "Matches: REAL | Pools/Odds: MOCK",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ status: "ok", matchesInDB: 0 });
  }
});

// ==================== AI ENDPOINTS ====================

// GET /api/ai/analyze/:matchId - Basic AI analysis
app.get("/api/ai/analyze/:matchId", async (req, res) => {
  try {
    console.log(`🔍 AI analyze requested for match: ${req.params.matchId}`);
    
    const result = await query("SELECT * FROM matches WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      console.log(`❌ Match ${req.params.matchId} not found in DB`);
      return res.status(404).json({ error: "Match not found" });
    }
    
    const match = result.rows[0];
    console.log(`✅ Match found: ${match.home_team} vs ${match.away_team}`);
    
    res.json({
      matchId: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      analysis: {
        prediction: { homeWin: 40, draw: 30, awayWin: 30 },
        mostLikely: "HOME_WIN",
        confidence: "Medium",
        insights: [
          `⚔️ Based on historical data`,
          `🔥 Home advantage factor`,
          `📊 Statistical analysis`
        ],
        keyFactors: ["Home advantage", "Recent form", "Head to head record"]
      },
      timestamp: new Date().toISOString(),
      note: "Configure Gemini AI for advanced analysis"
    });
    
  } catch (error) {
    console.error("❌ AI Analysis error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/gemini/:matchId - Gemini AI powered analysis (if configured)
app.get("/api/ai/gemini/:matchId", async (req, res) => {
  try {
    if (!aiAgent) {
      return res.status(503).json({ 
        error: "Gemini AI not configured",
        message: "Please set GEMINI_API_KEY environment variable"
      });
    }
    
    const result = await query("SELECT * FROM matches WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }
    
    const match = result.rows[0];
    console.log(`🤖 Gemini analyzing: ${match.home_team} vs ${match.away_team}`);
    
    const analysis = await aiAgent.predict(
      match.home_team,
      match.away_team,
      { competition: match.competition_name || "FIFA World Cup 2026" }
    );
    
    res.json({
      matchId: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      ...analysis,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("❌ Gemini Analysis error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/head2head - Head to head analysis
app.get("/api/ai/head2head", async (req, res) => {
  const { team1, team2 } = req.query;
  if (!team1 || !team2) {
    return res.status(400).json({ error: "Please provide team1 and team2" });
  }
  
  res.json({
    team1,
    team2,
    analysis: {
      totalMatches: 12,
      team1Wins: 5,
      team2Wins: 4,
      draws: 3,
      team1Goals: 15,
      team2Goals: 12,
      advantage: team1
    },
    note: "MOCK data - Configure Gemini for real analysis"
  });
});

// GET /api/ai/form/:team - Team form analysis
app.get("/api/ai/form/:team", async (req, res) => {
  res.json({
    team: req.params.team,
    formString: "WWDLW",
    formRating: "Good",
    averageGoalsFor: 1.8,
    averageGoalsAgainst: 1.2,
    trend: "📈 Improving",
    note: "MOCK data - Configure Gemini for real analysis"
  });
});

// GET /api/ai/predict - Quick prediction
app.get("/api/ai/predict", async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) {
    return res.status(400).json({ error: "Please provide home and away teams" });
  }
  
  res.json({
    homeTeam: home,
    awayTeam: away,
    prediction: { homeWin: 45, draw: 28, awayWin: 27 },
    mostLikely: "HOME_WIN",
    confidence: "Medium",
    note: "MOCK data - Configure Gemini for real analysis"
  });
});

// ==================== MATCH ENDPOINTS ====================

// GET /api/matches - REAL matches from API + MOCK pools/odds
app.get("/api/matches", async (req, res) => {
  try {
    const result = await query("SELECT * FROM matches ORDER BY start_time ASC");
    const matches = result.rows.map(formatMatch);
    
    res.json({ 
      matches,
      total: matches.length,
      source: "Real World Cup Data",
      pools: "MOCK data (for demo)",
      odds: "MOCK data (for demo)"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/matches/:id
app.get("/api/matches/:id", async (req, res) => {
  try {
    const result = await query("SELECT * FROM matches WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }
    res.json({ match: formatMatch(result.rows[0]) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATS ENDPOINTS ====================

// GET /api/stats - REAL match counts + MOCK betting data
app.get("/api/stats", async (req, res) => {
  try {
    const matchCount = await query("SELECT COUNT(*) FROM matches");
    const liveMatches = await query("SELECT COUNT(*) FROM matches WHERE status = 'IN_PLAY'");
    const finishedMatches = await query("SELECT COUNT(*) FROM matches WHERE status = 'FINISHED'");
    
    res.json({
      // REAL data
      matchCount: parseInt(matchCount.rows[0].count),
      liveMatches: parseInt(liveMatches.rows[0].count),
      finishedMatches: parseInt(finishedMatches.rows[0].count),
      // MOCK data
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678,
      note: "Stats: Real match counts, Mock betting data"
    });
  } catch (error) {
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

// GET /api/leaderboard - MOCK only
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

// GET /api/ultimate - MOCK only
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

// POST /api/refresh - Manually fetch matches
app.post("/api/refresh", async (req, res) => {
  try {
    const matches = await fetchWorldCupMatches();
    const stored = await storeMatches(matches);
    const total = await query("SELECT COUNT(*) FROM matches");
    
    res.json({ 
      success: true, 
      message: stored > 0 ? `Fetched ${stored} new World Cup matches` : "No new matches",
      totalMatches: parseInt(total.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/debug
app.get("/api/debug", async (req, res) => {
  const count = await query("SELECT COUNT(*) FROM matches");
  const sample = await query("SELECT * FROM matches LIMIT 1");
  
  res.json({
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
    geminiKey: GEMINI_API_KEY ? "✅" : "❌",
    matchesInDB: parseInt(count.rows[0].count),
    sampleMatch: sample.rows[0] || null,
    note: "Matches: REAL | Other data: MOCK"
  });
});

// ─── Initialize ─────────────────────────────────────────────────────────
async function initialize() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Starting World Cup API");
  console.log("=".repeat(60));
  console.log("✅ Matches: REAL data from Football-API");
  console.log("✅ Pools/Odds: MOCK data for demo");
  console.log("✅ Leaderboard/Ultimate: MOCK data for demo");
  console.log("=".repeat(60) + "\n");
  
  const matchCount = await initDatabase();
  
  if (matchCount === 0) {
    console.log("🔄 No matches found, fetching from API...");
    const matches = await fetchWorldCupMatches();
    if (matches.length > 0) {
      await storeMatches(matches);
    } else {
      console.log("⚠️ No World Cup matches available from API yet");
    }
  }
}

initialize().catch(console.error);

module.exports = app;