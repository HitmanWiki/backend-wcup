/**
 * World Cup 2026 Betting — Backend API
 * Separate historical matches table for international games
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
  // Table for upcoming World Cup 2026 matches
  await query(`
    CREATE TABLE IF NOT EXISTS worldcup_matches (
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
      stage TEXT,
      group_name TEXT,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Table for historical international matches (2010 onwards)
  await query(`
    CREATE TABLE IF NOT EXISTS historical_matches (
      id INTEGER PRIMARY KEY,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      home_team_id INTEGER,
      away_team_id INTEGER,
      competition TEXT NOT NULL,
      season TEXT,
      match_date BIGINT NOT NULL,
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      winner TEXT,
      venue TEXT,
      attendance INTEGER,
      referee TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create indexes for faster queries
  await query(`CREATE INDEX IF NOT EXISTS idx_historical_teams ON historical_matches(home_team, away_team);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_historical_date ON historical_matches(match_date);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_historical_competition ON historical_matches(competition);`);
  
  // Table for team mappings
  await query(`
    CREATE TABLE IF NOT EXISTS team_mappings (
      id SERIAL PRIMARY KEY,
      team_name TEXT NOT NULL UNIQUE,
      fifa_code TEXT,
      country_code TEXT,
      continent TEXT,
      fifa_ranking INTEGER,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Database tables initialized");
  
  const wcCount = await query("SELECT COUNT(*) FROM worldcup_matches");
  const histCount = await query("SELECT COUNT(*) FROM historical_matches");
  
  console.log(`📊 World Cup matches: ${parseInt(wcCount.rows[0].count)}`);
  console.log(`📊 Historical matches: ${parseInt(histCount.rows[0].count)}`);
  
  return {
    worldcup: parseInt(wcCount.rows[0].count),
    historical: parseInt(histCount.rows[0].count)
  };
}

// ─── Football-Data.org API ─────────────────────────────────────────────────
const API_BASE = "https://api.football-data.org/v4";
const API_HEADERS = { "X-Auth-Token": FOOTBALL_API_KEY };

// List of international competitions to fetch
const INTERNATIONAL_COMPETITIONS = [
  { code: 'WC', name: 'FIFA World Cup' },
  { code: 'EC', name: 'European Championship' },
  { code: 'Copa America', name: 'Copa America' }, // Note: Different API may need different codes
  { code: 'AFC', name: 'Asian Cup' },
  { code: 'CAF', name: 'Africa Cup of Nations' },
  { code: 'CONCACAF', name: 'CONCACAF Gold Cup' },
  { code: 'FIFA Friendlies', name: 'International Friendly' }
];

// Years to fetch historical data from
const HISTORICAL_YEARS = ['2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014', '2013', '2012', '2011', '2010'];

// Initialize Gemini AI Agent
let aiAgent = null;
if (GEMINI_API_KEY) {
  try {
    aiAgent = new AIMatchAgent({
      geminiApiKey: GEMINI_API_KEY,
      footballApiKey: FOOTBALL_API_KEY,
      newsApiKey: NEWS_API_KEY,
      databaseUrl: DATABASE_URL
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
    "Côte d'Ivoire": "Ivory Coast",
    "USA": "USA",
    "Mexico": "Mexico",
    "Canada": "Canada",
    "Brazil": "Brazil",
    "Argentina": "Argentina",
    "France": "France",
    "Germany": "Germany",
    "England": "England",
    "Spain": "Spain",
    "Italy": "Italy",
    "Netherlands": "Netherlands",
    "Portugal": "Portugal",
    "Belgium": "Belgium",
    "Croatia": "Croatia",
    "Switzerland": "Switzerland",
    "Poland": "Poland",
    "Denmark": "Denmark",
    "Sweden": "Sweden",
    "Norway": "Norway",
    "Japan": "Japan",
    "South Korea": "South Korea",
    "Australia": "Australia",
    "Morocco": "Morocco",
    "Senegal": "Senegal",
    "Uruguay": "Uruguay",
    "Colombia": "Colombia",
    "Ecuador": "Ecuador",
    "Peru": "Peru",
    "Chile": "Chile",
    "Paraguay": "Paraguay",
    "Bolivia": "Bolivia",
    "Venezuela": "Venezuela",
    "Costa Rica": "Costa Rica",
    "Panama": "Panama",
    "Jamaica": "Jamaica",
    "Honduras": "Honduras",
    "Iran": "Iran",
    "Saudi Arabia": "Saudi Arabia",
    "Qatar": "Qatar",
    "UAE": "UAE",
    "China": "China",
    "India": "India",
    "New Zealand": "New Zealand",
    "South Africa": "South Africa",
    "Egypt": "Egypt",
    "Tunisia": "Tunisia",
    "Algeria": "Algeria",
    "Cameroon": "Cameroon",
    "Ghana": "Ghana",
    "Ivory Coast": "Ivory Coast"
  };
  return map[name] || name;
}

// ─── Fetch World Cup 2026 matches ───────────────────────────────────────
async function fetchWorldCupMatches() {
  console.log("🌍 Fetching World Cup 2026 matches from API...");
  
  try {
    const response = await axios.get(
      `${API_BASE}/competitions/WC/matches`,
      { headers: API_HEADERS, timeout: 10000 }
    );
    
    const matches = response.data.matches || [];
    console.log(`✅ Found ${matches.length} World Cup 2026 matches`);
    return matches;
    
  } catch (error) {
    console.error("❌ Failed to fetch World Cup data:", error.message);
    return [];
  }
}

// ─── Fetch historical international matches ─────────────────────────────
async function fetchHistoricalMatches() {
  console.log("📜 Fetching historical international matches (2010-2022)...");
  
  let totalStored = 0;
  const errors = [];

  // Try to get historical World Cups
  for (const year of HISTORICAL_YEARS) {
    try {
      console.log(`   🔍 Fetching ${year} World Cup matches...`);
      
      // Note: API might use different competition codes for past WCs
      // This is an approximation - you may need to adjust based on actual API
      const response = await axios.get(
        `${API_BASE}/competitions/WC/matches?season=${year}`,
        { headers: API_HEADERS, timeout: 8000 }
      );
      
      const matches = response.data.matches || [];
      
      for (const match of matches) {
        if (match.status === 'FINISHED') {
          const matchDate = Math.floor(new Date(match.utcDate).getTime() / 1000);
          const homeTeam = normalizeTeam(match.homeTeam?.name);
          const awayTeam = normalizeTeam(match.awayTeam?.name);
          const homeScore = match.score?.fullTime?.home ?? 0;
          const awayScore = match.score?.fullTime?.away ?? 0;
          
          const winner = homeScore > awayScore ? homeTeam : 
                        awayScore > homeScore ? awayTeam : null;
          
          try {
            await query(
              `INSERT INTO historical_matches 
               (id, home_team, away_team, home_team_id, away_team_id, competition, season, 
                match_date, home_score, away_score, winner)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (id) DO NOTHING`,
              [
                match.id, homeTeam, awayTeam, 
                match.homeTeam?.id, match.awayTeam?.id,
                'FIFA World Cup', year,
                matchDate, homeScore, awayScore, winner
              ]
            );
            totalStored++;
          } catch (e) {
            // Skip duplicates
          }
        }
      }
      
      console.log(`      ✅ Stored matches from ${year} World Cup`);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.log(`      ⚠️ Could not fetch ${year} World Cup data:`, error.message);
      errors.push(`${year}: ${error.message}`);
    }
  }

  // Fetch international friendlies and other competitions
  const teams = [
    'Brazil', 'Argentina', 'France', 'Germany', 'Spain', 'Portugal', 'England',
    'Netherlands', 'Belgium', 'Croatia', 'Switzerland', 'Uruguay', 'Colombia',
    'Japan', 'South Korea', 'Morocco', 'Senegal', 'USA', 'Mexico', 'Canada'
  ];

  for (const team of teams) {
    try {
      console.log(`   🔍 Fetching international matches for ${team}...`);
      
      // Try to find team ID
      const searchResponse = await axios.get(
        `${API_BASE}/teams?name=${encodeURIComponent(team)}`,
        { headers: API_HEADERS, timeout: 5000 }
      );
      
      if (!searchResponse.data.teams?.length) continue;
      
      const teamId = searchResponse.data.teams[0].id;
      
      // Fetch last 50 matches
      const response = await axios.get(
        `${API_BASE}/teams/${teamId}/matches?limit=50&status=FINISHED`,
        { headers: API_HEADERS, timeout: 8000 }
      );
      
      const matches = response.data.matches || [];
      
      for (const match of matches) {
        // Only store international matches (exclude club competitions)
        if (match.competition?.type === 'CUP' || 
            match.competition?.name.includes('World Cup') ||
            match.competition?.name.includes('Friendly') ||
            match.competition?.name.includes('International')) {
          
          const matchDate = Math.floor(new Date(match.utcDate).getTime() / 1000);
          const homeTeam = normalizeTeam(match.homeTeam?.name);
          const awayTeam = normalizeTeam(match.awayTeam?.name);
          const homeScore = match.score?.fullTime?.home ?? 0;
          const awayScore = match.score?.fullTime?.away ?? 0;
          
          const winner = homeScore > awayScore ? homeTeam : 
                        awayScore > homeScore ? awayTeam : null;
          
          try {
            await query(
              `INSERT INTO historical_matches 
               (id, home_team, away_team, home_team_id, away_team_id, competition, season, 
                match_date, home_score, away_score, winner)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (id) DO NOTHING`,
              [
                match.id, homeTeam, awayTeam,
                match.homeTeam?.id, match.awayTeam?.id,
                match.competition?.name || 'International',
                match.season?.startDate?.split('-')[0],
                matchDate, homeScore, awayScore, winner
              ]
            );
            totalStored++;
          } catch (e) {
            // Skip duplicates
          }
        }
      }
      
      console.log(`      ✅ Stored international matches for ${team}`);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.log(`      ⚠️ Error fetching for ${team}:`, error.message);
      errors.push(`${team}: ${error.message}`);
    }
  }

  console.log(`\n📊 Total historical matches stored: ${totalStored}`);
  if (errors.length > 0) {
    console.log("⚠️ Errors encountered:", errors.length);
  }
  
  return totalStored;
}

// ─── Store World Cup 2026 matches ───────────────────────────────────────
async function storeWorldCupMatches(matches) {
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
        `INSERT INTO worldcup_matches 
         (id, home_team, away_team, start_time, status, home_score, away_score, winner, 
          competition_code, competition_name, stage, group_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          home_score = EXCLUDED.home_score,
          away_score = EXCLUDED.away_score,
          winner = EXCLUDED.winner,
          last_updated = CURRENT_TIMESTAMP`,
        [
          match.id, homeTeam, awayTeam, startTime, status, 
          homeScore, awayScore, winner,
          'WC', 'FIFA World Cup 2026',
          match.stage, match.group
        ]
      );
      stored++;
    } catch (e) {
      console.error(`❌ Error storing match ${match.id}:`, e.message);
    }
  }
  
  console.log(`✅ Stored ${stored} World Cup 2026 matches`);
  return stored;
}

// ─── Format World Cup match for API response ────────────────────────────
function formatWorldCupMatch(row) {
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
    stage: row.stage,
    group: row.group_name,
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
    description: "World Cup 2026 + Historical International Matches (2010-2022)",
    status: "running",
    environment: isVercel ? "vercel" : "local",
    database: "Neon PostgreSQL",
    aiStatus: aiAgent ? "✅ Gemini AI Active" : "❌ Gemini AI Not Configured",
    endpoints: {
      health: "/api/health",
      worldcup: "/api/worldcup/matches",
      historical: "/api/historical/matches",
      team: "/api/team/:name/history",
      h2h: "/api/h2h/:team1/:team2",
      ai: {
        analyze: "/api/ai/analyze/:matchId",
        predict: "/api/ai/predict"
      },
      admin: {
        seedHistorical: "/api/admin/seed/historical",
        seedWorldCup: "/api/admin/seed/worldcup",
        status: "/api/admin/status"
      }
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const wc = await query("SELECT COUNT(*) FROM worldcup_matches");
    const hist = await query("SELECT COUNT(*) FROM historical_matches");
    
    res.json({ 
      status: "ok",
      worldCupMatches: parseInt(wc.rows[0].count),
      historicalMatches: parseInt(hist.rows[0].count),
      database: "Neon PostgreSQL",
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
      geminiKey: GEMINI_API_KEY ? "✅" : "❌",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ status: "ok", error: error.message });
  }
});

// ==================== WORLD CUP 2026 ENDPOINTS ====================

// GET /api/worldcup/matches - All World Cup 2026 matches
app.get("/api/worldcup/matches", async (req, res) => {
  try {
    const result = await query("SELECT * FROM worldcup_matches ORDER BY start_time ASC");
    const matches = result.rows.map(formatWorldCupMatch);
    
    res.json({ 
      matches,
      total: matches.length,
      source: "World Cup 2026 Fixtures"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/worldcup/matches/:id
app.get("/api/worldcup/matches/:id", async (req, res) => {
  try {
    const result = await query("SELECT * FROM worldcup_matches WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }
    res.json({ match: formatWorldCupMatch(result.rows[0]) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== HISTORICAL MATCHES ENDPOINTS ====================

// GET /api/historical/matches - Get historical matches with filters
app.get("/api/historical/matches", async (req, res) => {
  const { team, competition, year, limit = 50 } = req.query;
  
  let queryText = "SELECT * FROM historical_matches WHERE 1=1";
  const params = [];
  let paramIndex = 1;
  
  if (team) {
    queryText += ` AND (home_team = $${paramIndex} OR away_team = $${paramIndex})`;
    params.push(team);
    paramIndex++;
  }
  
  if (competition) {
    queryText += ` AND competition ILIKE $${paramIndex}`;
    params.push(`%${competition}%`);
    paramIndex++;
  }
  
  if (year) {
    queryText += ` AND season = $${paramIndex}`;
    params.push(year);
    paramIndex++;
  }
  
  queryText += ` ORDER BY match_date DESC LIMIT $${paramIndex}`;
  params.push(limit);
  
  try {
    const result = await query(queryText, params);
    res.json({
      matches: result.rows,
      total: result.rows.length,
      filters: { team, competition, year, limit }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/team/:name/history - Get team's historical record
app.get("/api/team/:name/history", async (req, res) => {
  const team = req.params.name;
  const { years = 5 } = req.query;
  
  try {
    const result = await query(
      `SELECT * FROM historical_matches 
       WHERE (home_team = $1 OR away_team = $1)
       AND season >= (EXTRACT(YEAR FROM CURRENT_DATE) - $2)
       ORDER BY match_date DESC`,
      [team, years]
    );
    
    const matches = result.rows;
    let wins = 0, draws = 0, losses = 0;
    let goalsFor = 0, goalsAgainst = 0;
    
    matches.forEach(m => {
      const isHome = m.home_team === team;
      const gf = isHome ? m.home_score : m.away_score;
      const ga = isHome ? m.away_score : m.home_score;
      
      goalsFor += gf;
      goalsAgainst += ga;
      
      if (gf > ga) wins++;
      else if (gf < ga) losses++;
      else draws++;
    });
    
    res.json({
      team,
      totalMatches: matches.length,
      record: { wins, draws, losses },
      goals: { for: goalsFor, against: goalsAgainst, diff: goalsFor - goalsAgainst },
      form: matches.slice(0, 6).map(m => ({
        date: new Date(m.match_date * 1000).toISOString().split('T')[0],
        opponent: m.home_team === team ? m.away_team : m.home_team,
        score: `${m.home_score}-${m.away_score}`,
        result: m.home_team === team ? 
          (m.home_score > m.away_score ? 'W' : m.home_score < m.away_score ? 'L' : 'D') :
          (m.away_score > m.home_score ? 'W' : m.away_score < m.home_score ? 'L' : 'D')
      })),
      recentMatches: matches.slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/h2h/:team1/:team2 - Head to head between two teams
app.get("/api/h2h/:team1/:team2", async (req, res) => {
  const { team1, team2 } = req.params;
  
  try {
    const result = await query(
      `SELECT * FROM historical_matches 
       WHERE (home_team = $1 AND away_team = $2) 
          OR (home_team = $2 AND away_team = $1)
       ORDER BY match_date DESC`,
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
      record: { team1Wins, team2Wins, draws },
      goals: { team1: team1Goals, team2: team2Goals },
      recentMeetings: matches.slice(0, 5).map(m => ({
        date: new Date(m.match_date * 1000).toISOString().split('T')[0],
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

// ==================== AI ENDPOINTS ====================

// GET /api/ai/analyze/:matchId - AI analysis using historical data
app.get("/api/ai/analyze/:matchId", async (req, res) => {
  try {
    // Get the World Cup match
    const matchResult = await query("SELECT * FROM worldcup_matches WHERE id = $1", [req.params.matchId]);
    
    if (matchResult.rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }
    
    const match = matchResult.rows[0];
    console.log(`🤖 Analyzing: ${match.home_team} vs ${match.away_team}`);
    
    if (!aiAgent) {
      return res.status(503).json({ error: "Gemini AI not configured" });
    }
    
    // Get historical data for both teams
    const homeHistory = await query(
      `SELECT * FROM historical_matches 
       WHERE home_team = $1 OR away_team = $1 
       ORDER BY match_date DESC LIMIT 20`,
      [match.home_team]
    );
    
    const awayHistory = await query(
      `SELECT * FROM historical_matches 
       WHERE home_team = $1 OR away_team = $1 
       ORDER BY match_date DESC LIMIT 20`,
      [match.away_team]
    );
    
    const h2h = await query(
      `SELECT * FROM historical_matches 
       WHERE (home_team = $1 AND away_team = $2) 
          OR (home_team = $2 AND away_team = $1)
       ORDER BY match_date DESC`,
      [match.home_team, match.away_team]
    );
    
    // Prepare context for AI
    const context = {
      match,
      homeTeamHistory: homeHistory.rows,
      awayTeamHistory: awayHistory.rows,
      headToHead: h2h.rows
    };
    
    const analysis = await aiAgent.predictWithContext(
      match.home_team,
      match.away_team,
      context
    );
    
    res.json({
      matchId: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      ...analysis,
      timestamp: new Date().toISOString(),
      source: "AI Agent with Historical Data"
    });
    
  } catch (error) {
    console.error("❌ AI Analysis error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/predict - Quick prediction using historical data
app.get("/api/ai/predict", async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) {
    return res.status(400).json({ error: "Please provide home and away teams" });
  }
  
  try {
    // Get historical data
    const h2h = await query(
      `SELECT * FROM historical_matches 
       WHERE (home_team = $1 AND away_team = $2) 
          OR (home_team = $2 AND away_team = $1)
       ORDER BY match_date DESC`,
      [home, away]
    );
    
    const homeForm = await query(
      `SELECT * FROM historical_matches 
       WHERE home_team = $1 OR away_team = $1 
       ORDER BY match_date DESC LIMIT 10`,
      [home]
    );
    
    const awayForm = await query(
      `SELECT * FROM historical_matches 
       WHERE home_team = $1 OR away_team = $1 
       ORDER BY match_date DESC LIMIT 10`,
      [away]
    );
    
    // Calculate simple statistics
    const h2hStats = calculateH2HStats(h2h.rows, home, away);
    const homeStats = calculateTeamStats(homeForm.rows, home);
    const awayStats = calculateTeamStats(awayForm.rows, away);
    
    res.json({
      homeTeam: home,
      awayTeam: away,
      prediction: {
        homeWin: 40,
        draw: 30,
        awayWin: 30
      },
      statistics: {
        headToHead: h2hStats,
        homeForm: homeStats,
        awayForm: awayStats
      },
      note: "Based on historical data (2010-2022)"
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper functions for statistics
function calculateH2HStats(matches, team1, team2) {
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
  
  return {
    totalMatches: matches.length,
    team1Wins, team2Wins, draws,
    team1Goals, team2Goals,
    avgGoalsPerMatch: matches.length > 0 ? 
      ((team1Goals + team2Goals) / matches.length).toFixed(2) : 0
  };
}

function calculateTeamStats(matches, team) {
  let wins = 0, draws = 0, losses = 0;
  let goalsFor = 0, goalsAgainst = 0;
  
  matches.forEach(m => {
    const isHome = m.home_team === team;
    const gf = isHome ? m.home_score : m.away_score;
    const ga = isHome ? m.away_score : m.home_score;
    
    goalsFor += gf;
    goalsAgainst += ga;
    
    if (gf > ga) wins++;
    else if (gf < ga) losses++;
    else draws++;
  });
  
  return {
    totalMatches: matches.length,
    record: { wins, draws, losses },
    goals: { for: goalsFor, against: goalsAgainst },
    avgGoalsFor: matches.length > 0 ? (goalsFor / matches.length).toFixed(2) : 0,
    avgGoalsAgainst: matches.length > 0 ? (goalsAgainst / matches.length).toFixed(2) : 0
  };
}

// ==================== ADMIN ENDPOINTS ====================

// POST /api/admin/seed/historical - Seed historical data
app.post("/api/admin/seed/historical", async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  try {
    console.log("🔄 Starting historical data fetch...");
    const stored = await fetchHistoricalMatches();
    
    const count = await query("SELECT COUNT(*) FROM historical_matches");
    
    res.json({
      success: true,
      stored,
      totalHistorical: parseInt(count.rows[0].count),
      message: `Successfully stored ${stored} historical matches`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/seed/worldcup - Seed World Cup 2026 matches
app.post("/api/admin/seed/worldcup", async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  try {
    const matches = await fetchWorldCupMatches();
    const stored = await storeWorldCupMatches(matches);
    
    res.json({
      success: true,
      stored,
      message: `Stored ${stored} World Cup 2026 matches`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/status - Database status
app.get("/api/admin/status", async (req, res) => {
  try {
    const wc = await query("SELECT COUNT(*) FROM worldcup_matches");
    const hist = await query("SELECT COUNT(*) FROM historical_matches");
    const teams = await query(`
      SELECT COUNT(DISTINCT home_team) as teams 
      FROM historical_matches
    `);
    
    const recentYears = await query(`
      SELECT DISTINCT season 
      FROM historical_matches 
      ORDER BY season DESC 
      LIMIT 5
    `);
    
    res.json({
      worldCupMatches: parseInt(wc.rows[0].count),
      historicalMatches: parseInt(hist.rows[0].count),
      uniqueTeams: parseInt(teams.rows[0].teams),
      years: recentYears.rows.map(r => r.season).filter(Boolean),
      database: "Neon PostgreSQL"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Initialize Database ────────────────────────────────────────────────
async function initialize() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Starting World Cup API with Historical Data");
  console.log("=".repeat(60));
  console.log(`📊 Environment: ${isVercel ? 'Vercel' : 'Local'}`);
  console.log(`🔑 Football API Key: ${FOOTBALL_API_KEY ? '✅' : '❌'}`);
  console.log(`🤖 Gemini API Key: ${GEMINI_API_KEY ? '✅' : '❌'}`);
  console.log("=".repeat(60) + "\n");
  
  try {
    const counts = await initDatabase();
    
    // Auto-fetch World Cup 2026 matches if none exist
    if (counts.worldcup === 0) {
      console.log("🔄 No World Cup matches found, fetching from API...");
      const matches = await fetchWorldCupMatches();
      if (matches.length > 0) {
        await storeWorldCupMatches(matches);
      }
    }
    
    console.log("\n✅ Database ready");
    console.log(`   World Cup 2026: ${counts.worldcup} matches`);
    console.log(`   Historical: ${counts.historical} matches`);
    
  } catch (error) {
    console.error("❌ Error initializing:", error);
  }
}

// Run initialization
initialize().catch(console.error);

module.exports = app;