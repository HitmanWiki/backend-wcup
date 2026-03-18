/**
 * World Cup 2026 Betting — Backend API
 * Fetches and stores both historical and upcoming matches
 * AI Agent analyzes from database
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
  // Create matches table with indexes for performance
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
      is_historical BOOLEAN DEFAULT FALSE,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Create indexes for faster queries
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_team ON matches(home_team, away_team);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_historical ON matches(is_historical);`);
  
  // Create teams table for caching team IDs
  await query(`
    CREATE TABLE IF NOT EXISTS teams (
      name TEXT PRIMARY KEY,
      team_id INTEGER NOT NULL,
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

// List of World Cup teams for historical data fetching
const WC_TEAMS = [
  'Brazil', 'Argentina', 'France', 'Germany', 'Spain', 'Portugal', 'England',
  'Netherlands', 'Belgium', 'Croatia', 'Switzerland', 'Uruguay', 'Colombia',
  'Japan', 'South Korea', 'Morocco', 'Senegal', 'USA', 'Mexico', 'Canada',
  'Poland', 'Denmark', 'Sweden', 'Norway', 'Wales', 'Scotland', 'Australia',
  'Iran', 'Saudi Arabia', 'Qatar', 'Tunisia', 'Algeria', 'Nigeria', 'Ghana',
  'Cameroon', 'Ivory Coast', 'Ecuador', 'Peru', 'Chile', 'Paraguay', 'Bolivia',
  'Venezuela', 'Costa Rica', 'Panama', 'Jamaica', 'Honduras', 'South Africa',
  'Egypt', 'Morocco', 'Senegal', 'Tunisia', 'Algeria', 'Nigeria'
];

// Initialize Gemini AI Agent (if API key exists)
let aiAgent = null;
if (GEMINI_API_KEY) {
  try {
    aiAgent = new AIMatchAgent({
      geminiApiKey: GEMINI_API_KEY,
      footballApiKey: FOOTBALL_API_KEY,
      newsApiKey: NEWS_API_KEY,
      databaseUrl: DATABASE_URL  // Pass DB connection to agent
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

// ─── Helper: Get or cache team ID ─────────────────────────────────────────
async function getTeamId(teamName) {
  try {
    // Check cache first
    const cached = await query("SELECT team_id FROM teams WHERE name = $1", [teamName]);
    if (cached.rows.length > 0) {
      return cached.rows[0].team_id;
    }
    
    // Fetch from API
    const response = await axios.get(
      `${API_BASE}/teams?name=${encodeURIComponent(teamName)}`,
      { headers: API_HEADERS, timeout: 5000 }
    );
    
    if (response.data.teams?.length > 0) {
      const teamId = response.data.teams[0].id;
      await query(
        "INSERT INTO teams (name, team_id) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET team_id = $2",
        [teamName, teamId]
      );
      return teamId;
    }
  } catch (error) {
    console.error(`❌ Error getting team ID for ${teamName}:`, error.message);
  }
  return null;
}

// ─── Fetch ALL World Cup matches (historical + upcoming) ─────────────────
async function fetchAllWorldCupMatches() {
  console.log("🌍 Fetching ALL World Cup matches (historical + upcoming)...");
  
  try {
    const response = await axios.get(
      `${API_BASE}/competitions/WC/matches`,
      { headers: API_HEADERS, timeout: 10000 }
    );
    
    const matches = response.data.matches || [];
    console.log(`✅ Found ${matches.length} total World Cup matches`);
    
    // Separate historical and upcoming
    const now = new Date().toISOString();
    const historical = matches.filter(m => m.status === 'FINISHED');
    const upcoming = matches.filter(m => m.status !== 'FINISHED');
    
    console.log(`   📜 Historical: ${historical.length} matches`);
    console.log(`   🔮 Upcoming: ${upcoming.length} matches`);
    
    return { matches, historical, upcoming };
    
  } catch (error) {
    console.error("❌ Failed to fetch World Cup data:", error.message);
    return { matches: [], historical: [], upcoming: [] };
  }
}

// ─── Fetch historical matches for all World Cup teams ────────────────────
async function fetchHistoricalMatches() {
  console.log("📜 Fetching historical matches for World Cup teams...");
  
  let totalStored = 0;
  const errors = [];
  
  for (const team of WC_TEAMS) {
    try {
      console.log(`   🔍 Fetching history for ${team}...`);
      
      const teamId = await getTeamId(team);
      if (!teamId) {
        console.log(`   ⚠️ Could not find ID for ${team}, skipping`);
        continue;
      }
      
      // Fetch last 50 matches for each team
      const response = await axios.get(
        `${API_BASE}/teams/${teamId}/matches?limit=50&status=FINISHED`,
        { headers: API_HEADERS, timeout: 8000 }
      );
      
      const matches = response.data.matches || [];
      let stored = 0;
      
      for (const match of matches) {
        // Only store international matches (exclude club competitions)
        if (match.competition?.type === 'CUP' || match.competition?.name.includes('World Cup')) {
          const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
          const homeTeam = normalizeTeam(match.homeTeam?.name);
          const awayTeam = normalizeTeam(match.awayTeam?.name);
          const homeScore = match.score?.fullTime?.home ?? 0;
          const awayScore = match.score?.fullTime?.away ?? 0;
          
          const winner = homeScore > awayScore ? homeTeam : 
                        awayScore > homeScore ? awayTeam : null;
          
          try {
            await query(
              `INSERT INTO matches 
               (id, home_team, away_team, start_time, status, home_score, away_score, winner, 
                competition_code, competition_name, season, matchday, is_historical)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               ON CONFLICT (id) DO NOTHING`,
              [
                match.id, homeTeam, awayTeam, startTime, 'FINISHED', 
                homeScore, awayScore, winner,
                match.competition?.code || 'INTL',
                match.competition?.name || 'International',
                match.season?.startDate?.split('-')[0],
                match.matchday,
                true
              ]
            );
            stored++;
          } catch (e) {
            // Skip duplicates
          }
        }
      }
      
      totalStored += stored;
      console.log(`   ✅ Stored ${stored} historical matches for ${team}`);
      
      // Rate limiting - don't hit API too hard
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      errors.push(`${team}: ${error.message}`);
      console.error(`   ❌ Error for ${team}:`, error.message);
    }
  }
  
  console.log(`\n📊 Total historical matches stored: ${totalStored}`);
  if (errors.length > 0) {
    console.log("⚠️ Errors encountered:", errors);
  }
  
  return totalStored;
}

// ─── Store matches in Neon PostgreSQL ────────────────────────────────────
async function storeMatches(matches, isHistorical = false) {
  if (matches.length === 0) return 0;
  
  let stored = 0;
  for (const match of matches) {
    const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
    const homeTeam = normalizeTeam(match.homeTeam?.name || "TBD");
    const awayTeam = normalizeTeam(match.awayTeam?.name || "TBD");
    const status = match.status || "SCHEDULED";
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const season = match.season?.startDate?.split('-')[0];
    const matchday = match.matchday;
    
    let winner = null;
    if (status === "FINISHED" && homeScore !== awayScore) {
      winner = homeScore > awayScore ? homeTeam : awayTeam;
    }
    
    try {
      await query(
        `INSERT INTO matches 
         (id, home_team, away_team, start_time, status, home_score, away_score, winner, 
          competition_code, competition_name, season, matchday, is_historical)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          home_score = EXCLUDED.home_score,
          away_score = EXCLUDED.away_score,
          winner = EXCLUDED.winner,
          last_updated = CURRENT_TIMESTAMP`,
        [
          match.id, homeTeam, awayTeam, startTime, status, 
          homeScore, awayScore, winner,
          match.competition?.code || 'WC',
          match.competition?.name || 'FIFA World Cup',
          season, matchday,
          isHistorical || status === 'FINISHED'
        ]
      );
      stored++;
    } catch (e) {
      console.error(`❌ Error storing match ${match.id}:`, e.message);
    }
  }
  
  console.log(`✅ Stored ${stored} matches (historical: ${isHistorical})`);
  return stored;
}

// ─── Format match for API response ────────────────────────────────────────
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
    season: row.season,
    matchday: row.matchday,
    isHistorical: row.is_historical,
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
//  API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "World Cup 2026 API",
    description: "Complete World Cup data - Historical + Upcoming matches",
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
      historical: {
        fetch: "/api/historical/fetch",
        status: "/api/historical/status"
      },
      refresh: "/api/refresh",
      debug: "/api/debug"
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const matches = await query("SELECT COUNT(*) FROM matches");
    const historical = await query("SELECT COUNT(*) FROM matches WHERE is_historical = true");
    const upcoming = await query("SELECT COUNT(*) FROM matches WHERE status = 'SCHEDULED'");
    
    res.json({ 
      status: "ok",
      matchesInDB: parseInt(matches.rows[0].count),
      historicalMatches: parseInt(historical.rows[0].count),
      upcomingMatches: parseInt(upcoming.rows[0].count),
      database: "Neon PostgreSQL",
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
      geminiKey: GEMINI_API_KEY ? "✅" : "❌",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ status: "ok", matchesInDB: 0, error: error.message });
  }
});

// ==================== AI ENDPOINTS ====================

// GET /api/ai/analyze/:matchId - AI analysis using database + Gemini
app.get("/api/ai/analyze/:matchId", async (req, res) => {
  try {
    console.log(`🔍 AI analyze requested for match: ${req.params.matchId}`);
    
    const result = await query("SELECT * FROM matches WHERE id = $1", [req.params.matchId]);
    
    if (result.rows.length === 0) {
      console.log(`❌ Match ${req.params.matchId} not found in DB`);
      return res.status(404).json({ error: "Match not found" });
    }
    
    const match = result.rows[0];
    console.log(`✅ Match found: ${match.home_team} vs ${match.away_team}`);
    
    if (!aiAgent) {
      return res.status(503).json({ 
        error: "Gemini AI not configured",
        message: "Please set GEMINI_API_KEY environment variable"
      });
    }
    
    console.log("🤖 Using AI Agent for analysis");
    const analysis = await aiAgent.predict(
      match.home_team,
      match.away_team,
      { 
        competition: match.competition_name || "FIFA World Cup 2026",
        verbose: false 
      }
    );
    
    res.json({
      matchId: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      ...analysis,
      timestamp: new Date().toISOString(),
      source: "AI Agent Analysis"
    });
    
  } catch (error) {
    console.error("❌ AI Analysis error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/gemini/:matchId - Alias for /analyze
app.get("/api/ai/gemini/:matchId", async (req, res) => {
  res.redirect(`/api/ai/analyze/${req.params.matchId}`);
});

// GET /api/ai/head2head - Head to head from database
app.get("/api/ai/head2head", async (req, res) => {
  const { team1, team2 } = req.query;
  if (!team1 || !team2) {
    return res.status(400).json({ error: "Please provide team1 and team2" });
  }
  
  try {
    const result = await query(
      `SELECT * FROM matches 
       WHERE (home_team = $1 AND away_team = $2) 
          OR (home_team = $2 AND away_team = $1)
       ORDER BY start_time DESC`,
      [team1, team2]
    );
    
    const matches = result.rows;
    let team1Wins = 0, team2Wins = 0, draws = 0;
    let team1Goals = 0, team2Goals = 0;
    
    matches.forEach(m => {
      const isTeam1Home = m.home_team === team1;
      const t1Score = isTeam1Home ? m.home_score : m.away_score;
      const t2Score = isTeam1Home ? m.away_score : m.home_score;
      
      team1Goals += t1Score;
      team2Goals += t2Score;
      
      if (t1Score > t2Score) team1Wins++;
      else if (t1Score < t2Score) team2Wins++;
      else draws++;
    });
    
    res.json({
      team1,
      team2,
      totalMatches: matches.length,
      team1Wins,
      team2Wins,
      draws,
      team1Goals,
      team2Goals,
      recentMeetings: matches.slice(0, 5).map(m => ({
        date: new Date(m.start_time * 1000).toISOString().split('T')[0],
        home: m.home_team,
        away: m.away_team,
        score: `${m.home_score}-${m.away_score}`,
        winner: m.winner
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/form/:team - Team form from database
app.get("/api/ai/form/:team", async (req, res) => {
  const team = req.params.team;
  const limit = parseInt(req.query.limit) || 6;
  
  try {
    const result = await query(
      `SELECT * FROM matches 
       WHERE (home_team = $1 OR away_team = $1) 
       AND status = 'FINISHED'
       ORDER BY start_time DESC 
       LIMIT $2`,
      [team, limit]
    );
    
    const matches = result.rows;
    let form = [];
    let goalsFor = 0, goalsAgainst = 0;
    
    matches.forEach(m => {
      const isHome = m.home_team === team;
      const scored = isHome ? m.home_score : m.away_score;
      const conceded = isHome ? m.away_score : m.home_score;
      
      goalsFor += scored;
      goalsAgainst += conceded;
      
      let result = 'D';
      if (scored > conceded) result = 'W';
      else if (scored < conceded) result = 'L';
      
      form.push(result);
    });
    
    res.json({
      team,
      formString: form.join(''),
      played: matches.length,
      goalsFor,
      goalsAgainst,
      avgScored: matches.length > 0 ? (goalsFor / matches.length).toFixed(2) : 0,
      avgConceded: matches.length > 0 ? (goalsAgainst / matches.length).toFixed(2) : 0,
      recentMatches: matches.map(m => ({
        date: new Date(m.start_time * 1000).toISOString().split('T')[0],
        opponent: m.home_team === team ? m.away_team : m.home_team,
        score: `${m.home_score}-${m.away_score}`,
        result: m.home_team === team ? 
          (m.home_score > m.away_score ? 'W' : m.home_score < m.away_score ? 'L' : 'D') :
          (m.away_score > m.home_score ? 'W' : m.away_score < m.home_score ? 'L' : 'D')
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/predict - Quick prediction (redirects to analyze if match exists)
app.get("/api/ai/predict", async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) {
    return res.status(400).json({ error: "Please provide home and away teams" });
  }
  
  try {
    // Find a matching upcoming match in DB
    const match = await query(
      `SELECT * FROM matches 
       WHERE home_team = $1 AND away_team = $2 
          OR home_team = $2 AND away_team = $1
       ORDER BY start_time ASC LIMIT 1`,
      [home, away]
    );
    
    if (match.rows.length > 0) {
      // Redirect to analyze that match
      return res.redirect(`/api/ai/analyze/${match.rows[0].id}`);
    }
    
    // No match found, use AI agent directly
    if (!aiAgent) {
      return res.status(503).json({ error: "Gemini AI not configured" });
    }
    
    const analysis = await aiAgent.predict(home, away, {
      competition: "International Friendly",
      verbose: false
    });
    
    res.json({
      homeTeam: home,
      awayTeam: away,
      ...analysis,
      note: "No scheduled match found - generic prediction"
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MATCH ENDPOINTS ====================

// GET /api/matches - All matches (historical + upcoming)
app.get("/api/matches", async (req, res) => {
  try {
    const { type } = req.query; // 'historical', 'upcoming', or 'all'
    
    let queryText = "SELECT * FROM matches ORDER BY start_time ASC";
    if (type === 'historical') {
      queryText = "SELECT * FROM matches WHERE is_historical = true ORDER BY start_time DESC";
    } else if (type === 'upcoming') {
      queryText = "SELECT * FROM matches WHERE status = 'SCHEDULED' ORDER BY start_time ASC";
    }
    
    const result = await query(queryText);
    const matches = result.rows.map(formatMatch);
    
    res.json({ 
      matches,
      total: matches.length,
      source: "Database",
      note: type ? `Showing ${type} matches` : "All matches"
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

// ==================== HISTORICAL DATA ENDPOINTS ====================

// POST /api/historical/fetch - Fetch all historical data (protected)
app.post("/api/historical/fetch", async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  try {
    console.log("🔄 Starting historical data fetch...");
    const stored = await fetchHistoricalMatches();
    
    const total = await query("SELECT COUNT(*) FROM matches");
    const historical = await query("SELECT COUNT(*) FROM matches WHERE is_historical = true");
    
    res.json({
      success: true,
      stored,
      totalMatches: parseInt(total.rows[0].count),
      historicalMatches: parseInt(historical.rows[0].count),
      message: `Successfully fetched ${stored} historical matches`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/historical/status - Check historical data status
app.get("/api/historical/status", async (req, res) => {
  try {
    const total = await query("SELECT COUNT(*) FROM matches");
    const historical = await query("SELECT COUNT(*) FROM matches WHERE is_historical = true");
    const byTeam = await query(`
      SELECT home_team as team, COUNT(*) as matches
      FROM matches 
      WHERE is_historical = true 
      GROUP BY home_team 
      ORDER BY matches DESC 
      LIMIT 10
    `);
    
    res.json({
      totalMatches: parseInt(total.rows[0].count),
      historicalMatches: parseInt(historical.rows[0].count),
      topTeams: byTeam.rows,
      hasData: parseInt(historical.rows[0].count) > 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATS ENDPOINTS ====================

// GET /api/stats - REAL match counts
app.get("/api/stats", async (req, res) => {
  try {
    const matchCount = await query("SELECT COUNT(*) FROM matches");
    const historical = await query("SELECT COUNT(*) FROM matches WHERE is_historical = true");
    const liveMatches = await query("SELECT COUNT(*) FROM matches WHERE status = 'IN_PLAY'");
    const finishedMatches = await query("SELECT COUNT(*) FROM matches WHERE status = 'FINISHED'");
    const scheduledMatches = await query("SELECT COUNT(*) FROM matches WHERE status = 'SCHEDULED'");
    
    res.json({
      matchCount: parseInt(matchCount.rows[0].count),
      historicalMatches: parseInt(historical.rows[0].count),
      liveMatches: parseInt(liveMatches.rows[0].count),
      finishedMatches: parseInt(finishedMatches.rows[0].count),
      scheduledMatches: parseInt(scheduledMatches.rows[0].count),
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678,
      note: "Real match counts, Mock betting data"
    });
  } catch (error) {
    res.json({
      matchCount: 0,
      historicalMatches: 0,
      liveMatches: 0,
      finishedMatches: 0,
      scheduledMatches: 0,
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
      { user: "0x3456...7890", total_wagered: "38000", bet_count: 31 }
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
      { team: "France", amount: "32000" }
    ],
    note: "MOCK data for demo"
  });
});

// POST /api/refresh - Manually fetch World Cup matches
app.post("/api/refresh", async (req, res) => {
  try {
    const { matches } = await fetchAllWorldCupMatches();
    const stored = await storeMatches(matches);
    const total = await query("SELECT COUNT(*) FROM matches");
    
    res.json({ 
      success: true, 
      message: `Fetched ${stored} new matches`,
      totalMatches: parseInt(total.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/debug - System status
app.get("/api/debug", async (req, res) => {
  try {
    const count = await query("SELECT COUNT(*) FROM matches");
    const historical = await query("SELECT COUNT(*) FROM matches WHERE is_historical = true");
    const upcoming = await query("SELECT COUNT(*) FROM matches WHERE status = 'SCHEDULED'");
    const sample = await query("SELECT * FROM matches WHERE is_historical = true LIMIT 1");
    
    res.json({
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
      geminiKey: GEMINI_API_KEY ? "✅" : "❌",
      database: "Neon PostgreSQL",
      matches: {
        total: parseInt(count.rows[0].count),
        historical: parseInt(historical.rows[0].count),
        upcoming: parseInt(upcoming.rows[0].count)
      },
      sampleHistorical: sample.rows[0] || null,
      note: "Historical data seeded: " + (parseInt(historical.rows[0].count) > 0 ? "✅" : "❌")
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ─── Initialize Database and Fetch Data ────────────────────────────────
async function initialize() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Starting World Cup API with Historical Data");
  console.log("=".repeat(60));
  console.log(`📊 Environment: ${isVercel ? 'Vercel' : 'Local'}`);
  console.log(`🔑 Football API Key: ${FOOTBALL_API_KEY ? '✅' : '❌'}`);
  console.log(`🤖 Gemini API Key: ${GEMINI_API_KEY ? '✅' : '❌'}`);
  console.log(`🗄️  Database: Neon PostgreSQL`);
  console.log("=".repeat(60) + "\n");
  
  try {
    const matchCount = await initDatabase();
    
    if (matchCount === 0) {
      console.log("🔄 No matches found, fetching from API...");
      
      // First fetch all World Cup matches
      const { matches, historical, upcoming } = await fetchAllWorldCupMatches();
      await storeMatches(matches);
      
      // Then fetch additional historical data for all teams
      console.log("\n📜 Fetching additional historical matches...");
      await fetchHistoricalMatches();
      
      const newCount = await query("SELECT COUNT(*) FROM matches");
      const histCount = await query("SELECT COUNT(*) FROM matches WHERE is_historical = true");
      console.log(`\n✅ Database now has:`);
      console.log(`   - Total: ${newCount.rows[0].count} matches`);
      console.log(`   - Historical: ${histCount.rows[0].count} matches`);
    } else {
      console.log(`✅ Database already has ${matchCount} matches`);
    }
  } catch (error) {
    console.error("❌ Error initializing:", error);
  }
}

// Run initialization
initialize().catch(console.error);

module.exports = app;