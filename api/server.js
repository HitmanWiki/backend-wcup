/**
 * World Cup 2026 Betting — Backend API
 * Optimized for Vercel - Prioritizes leagues with data
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const isVercel = process.env.VERCEL === '1';

// ─── DB Setup for Vercel ──────────────────────────────────────────────────
const dbPath = isVercel ? '/tmp/worldcup.db' : './worldcup.db';
const db = new sqlite3.Database(dbPath);

// Promisify database operations
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Initialize database
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id          INTEGER PRIMARY KEY,
      home_team   TEXT NOT NULL,
      away_team   TEXT NOT NULL,
      start_time  INTEGER NOT NULL,
      status      TEXT DEFAULT 'SCHEDULED',
      home_score  INTEGER DEFAULT 0,
      away_score  INTEGER DEFAULT 0,
      winner      TEXT,
      pool_home   TEXT DEFAULT '0',
      pool_draw   TEXT DEFAULT '0',
      pool_away   TEXT DEFAULT '0',
      total_pool  TEXT DEFAULT '0'
    );
  `);
  
  console.log("✅ Database initialized at:", dbPath);
});

// ─── Football-Data.org API ─────────────────────────────────────────────────
const API_BASE = "https://api.football-data.org/v4";
const API_HEADERS = FOOTBALL_API_KEY ? { "X-Auth-Token": FOOTBALL_API_KEY } : {};

// ─── Helper: Normalize team names ─────────────────────────────────────────
function normalizeTeam(name) {
  const map = {
    "United States": "USA",
    "Korea Republic": "South Korea",
    "IR Iran": "Iran",
    "Bosnia-Herzegovina": "Bosnia",
    "Côte d'Ivoire": "Ivory Coast",
    "USA": "USA",
    "Mexico": "Mexico",
    "Canada": "Canada",
    "Brazil": "Brazil",
    "Argentina": "Argentina",
    "Germany": "Germany",
    "France": "France",
    "England": "England",
    "Spain": "Spain",
    "Italy": "Italy",
    "Netherlands": "Netherlands",
    "Portugal": "Portugal",
    "Belgium": "Belgium",
    "Croatia": "Croatia",
    "Morocco": "Morocco",
    "Japan": "Japan",
    "Senegal": "Senegal"
  };
  return map[name] || name;
}

// ─── Demo matches with World Cup teams ────────────────────────────────────
function getDemoMatches() {
  const now = Math.floor(Date.now() / 1000);
  return [
    // Today's matches
    {
      id: 1,
      utcDate: new Date(now * 1000 + 3600000).toISOString(), // 1 hour from now
      homeTeam: { name: "Brazil" },
      awayTeam: { name: "Argentina" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    },
    {
      id: 2,
      utcDate: new Date(now * 1000 + 7200000).toISOString(), // 2 hours from now
      homeTeam: { name: "France" },
      awayTeam: { name: "Germany" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    },
    {
      id: 3,
      utcDate: new Date(now * 1000 - 7200000).toISOString(), // 2 hours ago
      homeTeam: { name: "England" },
      awayTeam: { name: "Spain" },
      status: "IN_PLAY",
      score: { fullTime: { home: 1, away: 1 } }
    },
    {
      id: 4,
      utcDate: new Date(now * 1000 - 86400000).toISOString(), // Yesterday
      homeTeam: { name: "Italy" },
      awayTeam: { name: "Netherlands" },
      status: "FINISHED",
      score: { fullTime: { home: 2, away: 0 } }
    },
    {
      id: 5,
      utcDate: new Date(now * 1000 + 86400000).toISOString(), // Tomorrow
      homeTeam: { name: "Portugal" },
      awayTeam: { name: "Belgium" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    },
    {
      id: 6,
      utcDate: new Date(now * 1000 + 172800000).toISOString(), // Day after tomorrow
      homeTeam: { name: "USA" },
      awayTeam: { name: "Mexico" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    }
  ];
}

// ─── Store demo matches ───────────────────────────────────────────────────
async function storeDemoMatches() {
  const matches = getDemoMatches();
  await dbRun("DELETE FROM matches");
  
  for (const match of matches) {
    const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
    const homeScore = match.score?.fullTime?.home || 0;
    const awayScore = match.score?.fullTime?.away || 0;
    const winner = match.status === "FINISHED" && homeScore > awayScore ? match.homeTeam.name : 
                  match.status === "FINISHED" && awayScore > homeScore ? match.awayTeam.name : null;
    
    await dbRun(
      `INSERT INTO matches 
       (id, home_team, away_team, start_time, status, home_score, away_score, winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [match.id, match.homeTeam.name, match.awayTeam.name, startTime,
       match.status, homeScore, awayScore, winner]
    );
  }
  console.log("💾 Stored demo matches with World Cup teams");
  return matches.length;
}

// ─── Fetch matches from API with prioritization ───────────────────────────
async function fetchAndStoreMatches() {
  try {
    console.log("📡 Fetching matches from football-data.org...");
    
    // If no API key, use demo matches immediately
    if (!FOOTBALL_API_KEY) {
      console.log("⚠️ No API key found, using demo matches");
      await storeDemoMatches();
      return true;
    }
    
    // Priority order: Leagues most likely to have data
    const priorityLeagues = [
      { code: 'PL', name: 'Premier League' },
      { code: 'PD', name: 'La Liga' },
      { code: 'BL1', name: 'Bundesliga' },
      { code: 'SA', name: 'Serie A' },
      { code: 'FL1', name: 'Ligue 1' },
      { code: 'CL', name: 'Champions League' }
    ];
    
    let matches = [];
    let usedLeague = null;
    
    // Try each league with short timeout
    for (const league of priorityLeagues) {
      try {
        console.log(`   Fetching ${league.code} (${league.name})...`);
        
        const response = await axios.get(
          `${API_BASE}/competitions/${league.code}/matches?status=SCHEDULED,IN_PLAY,FINISHED&limit=15`,
          { 
            headers: API_HEADERS,
            timeout: 4000 // 4 second timeout
          }
        );
        
        if (response.data.matches && response.data.matches.length > 0) {
          matches = response.data.matches.slice(0, 20);
          usedLeague = league.name;
          console.log(`   ✅ Found ${matches.length} matches in ${league.code}`);
          break;
        }
      } catch (e) {
        console.log(`   ⚠️ ${league.code}: ${e.message}`);
        continue;
      }
    }
    
    // If API fetch failed, use demo matches
    if (matches.length === 0) {
      console.log("⚠️ No matches from API, using demo matches");
      await storeDemoMatches();
      return true;
    }
    
    // Clear and store new matches
    await dbRun("DELETE FROM matches");
    
    let stored = 0;
    for (const match of matches) {
      const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
      const homeTeam = normalizeTeam(match.homeTeam?.name || "TBD");
      const awayTeam = normalizeTeam(match.awayTeam?.name || "TBD");
      const status = match.status || "SCHEDULED";
      const homeScore = match.score?.fullTime?.home || 0;
      const awayScore = match.score?.fullTime?.away || 0;
      
      let winner = null;
      if (status === "FINISHED" && homeScore !== awayScore) {
        winner = homeScore > awayScore ? homeTeam : awayTeam;
      }
      
      try {
        await dbRun(
          `INSERT INTO matches 
           (id, home_team, away_team, start_time, status, home_score, away_score, winner)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [match.id, homeTeam, awayTeam, startTime, status, homeScore, awayScore, winner]
        );
        stored++;
      } catch (e) {
        // Skip duplicates
      }
    }
    
    console.log(`✅ Stored ${stored} matches from ${usedLeague || 'unknown league'}`);
    return true;
    
  } catch (error) {
    console.error("Error in fetchAndStoreMatches:", error.message);
    // Always have demo matches as fallback
    await storeDemoMatches();
    return false;
  }
}

// ─── Format match for API response ────────────────────────────────────────
function formatMatch(row) {
  const homePool = Math.floor(Math.random() * 10) + 5;
  const drawPool = Math.floor(Math.random() * 5) + 2;
  const awayPool = Math.floor(Math.random() * 8) + 3;
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
    score: {
      home: row.home_score,
      away: row.away_score
    },
    winner: row.winner,
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

// ─── API Endpoints ─────────────────────────────────────────────────────────

// GET /api/matches - Returns matches immediately
app.get("/api/matches", async (req, res) => {
  try {
    let rows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
    
    // If no matches, initialize with demo data (fast path)
    if (rows.length === 0) {
      await storeDemoMatches();
      rows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
    }
    
    res.json({ matches: rows.map(formatMatch) });
  } catch (error) {
    console.error("Error in /api/matches:", error);
    // Return demo matches on error
    const demoMatches = getDemoMatches().map(m => ({
      id: m.id,
      homeTeam: m.homeTeam.name,
      awayTeam: m.awayTeam.name,
      startTime: Math.floor(new Date(m.utcDate).getTime() / 1000),
      status: m.status,
      score: { home: m.score.fullTime.home || 0, away: m.score.fullTime.away || 0 },
      winner: null,
      pools: { home: "8", draw: "4", away: "6", total: "18" },
      odds: { home: 44.44, draw: 22.22, away: 33.33 },
      bettingOpen: true
    }));
    res.json({ matches: demoMatches });
  }
});

// GET /api/matches/:id
app.get("/api/matches/:id", async (req, res) => {
  try {
    const row = await dbGet("SELECT * FROM matches WHERE id=?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Match not found" });
    res.json({ match: formatMatch(row) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stats
app.get("/api/stats", async (req, res) => {
  try {
    const matchCount = await dbGet("SELECT COUNT(*) as c FROM matches") || { c: 6 };
    const liveMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='IN_PLAY'") || { c: 1 };
    const finishedMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='FINISHED'") || { c: 1 };
    
    res.json({
      matchCount: matchCount.c || 6,
      liveMatches: liveMatches.c || 1,
      finishedMatches: finishedMatches.c || 1,
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678
    });
  } catch (error) {
    // Return default stats on error
    res.json({
      matchCount: 6,
      liveMatches: 1,
      finishedMatches: 1,
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
    ]
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
    ]
  });
});

// GET /api/health
app.get("/api/health", async (req, res) => {
  const count = await dbGet("SELECT COUNT(*) as c FROM matches") || { c: 0 };
  res.json({ 
    status: "ok", 
    matches: count.c || 0,
    vercel: isVercel,
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
    message: "API is running"
  });
});

// POST /api/refresh - Manually trigger refresh
app.post("/api/refresh", async (req, res) => {
  const success = await fetchAndStoreMatches();
  res.json({ success, message: success ? "Matches refreshed" : "Using demo matches" });
});

// ─── Initialize on cold start ─────────────────────────────────────────────
async function initialize() {
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    if (!count || count.c === 0) {
      console.log("🔄 No matches found, initializing with demo data...");
      await storeDemoMatches();
    }
    
    // Try to fetch real matches in background (don't wait for response)
    fetchAndStoreMatches().catch(console.error);
    
  } catch (error) {
    console.error("Error initializing:", error);
    await storeDemoMatches();
  }
}

// Run initialization
initialize();

// ─── Export for Vercel ────────────────────────────────────────────────────
module.exports = app;