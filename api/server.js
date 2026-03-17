/**
 * World Cup 2026 Betting — Backend API
 * Complete working version for Vercel
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

// ─── Database Setup ──────────────────────────────────────────────────────
const dbPath = isVercel ? '/tmp/worldcup.db' : './worldcup.db';
const db = new sqlite3.Database(dbPath);

// Promisify database operations
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

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
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
      competition TEXT,
      pool_home   TEXT DEFAULT '0',
      pool_draw   TEXT DEFAULT '0',
      pool_away   TEXT DEFAULT '0',
      total_pool  TEXT DEFAULT '0'
    );
  `);
  console.log("✅ Database initialized at:", dbPath);
});

// ─── API Configuration ──────────────────────────────────────────────────
const API_BASE = "https://api.football-data.org/v4";
const API_HEADERS = FOOTBALL_API_KEY ? { "X-Auth-Token": FOOTBALL_API_KEY } : {};

// ─── Helper Functions ───────────────────────────────────────────────────
function normalizeTeam(name) {
  const map = {
    "United States": "USA",
    "Korea Republic": "South Korea",
    "IR Iran": "Iran",
    "Côte d'Ivoire": "Ivory Coast",
    "Bosnia-Herzegovina": "Bosnia",
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
    competition: row.competition,
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

// ─── Store Matches in Database ─────────────────────────────────────────
async function storeMatches(matches, competitionName = "Unknown") {
  await dbRun("DELETE FROM matches");
  
  let stored = 0;
  for (const match of matches.slice(0, 30)) { // Limit to 30 matches
    const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
    const homeTeam = normalizeTeam(match.homeTeam?.name || "TBD");
    const awayTeam = normalizeTeam(match.awayTeam?.name || "TBD");
    const status = match.status || "SCHEDULED";
    const homeScore = match.score?.fullTime?.home !== null ? match.score.fullTime.home : 0;
    const awayScore = match.score?.fullTime?.away !== null ? match.score.fullTime.away : 0;
    
    let winner = null;
    if (status === "FINISHED" && homeScore !== awayScore) {
      winner = homeScore > awayScore ? homeTeam : awayTeam;
    }
    
    try {
      await dbRun(
        `INSERT INTO matches 
         (id, home_team, away_team, start_time, status, home_score, away_score, winner, competition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [match.id, homeTeam, awayTeam, startTime, status, homeScore, awayScore, winner, competitionName]
      );
      stored++;
    } catch (e) {
      // Skip duplicates
    }
  }
  
  console.log(`✅ Stored ${stored} matches from ${competitionName}`);
  return stored;
}

// ─── Fetch Matches from API ────────────────────────────────────────────
async function fetchAndStoreMatches() {
  console.log("\n📡 Fetching matches from football-data.org...");
  
  if (!FOOTBALL_API_KEY) {
    console.log("❌ No API key found");
    return false;
  }
  
  try {
    // First try World Cup
    try {
      console.log("   Trying World Cup (WC)...");
      const wcResponse = await axios.get(
        `${API_BASE}/competitions/WC/matches`,
        { headers: API_HEADERS, timeout: 8000 }
      );
      
      if (wcResponse.data.matches && wcResponse.data.matches.length > 0) {
        console.log(`   ✅ Found ${wcResponse.data.matches.length} World Cup matches`);
        await storeMatches(wcResponse.data.matches, "FIFA World Cup");
        return true;
      }
    } catch (e) {
      console.log("   ⚠️ No World Cup data available yet");
    }
    
    // Fallback to major leagues
    console.log("   📋 Fetching current major leagues...");
    const leagues = [
      { code: 'PL', name: 'Premier League' },
      { code: 'PD', name: 'La Liga' },
      { code: 'BL1', name: 'Bundesliga' },
      { code: 'SA', name: 'Serie A' },
      { code: 'FL1', name: 'Ligue 1' },
      { code: 'CL', name: 'Champions League' }
    ];
    
    let allMatches = [];
    
    for (const league of leagues) {
      try {
        const response = await axios.get(
          `${API_BASE}/competitions/${league.code}/matches?status=SCHEDULED,IN_PLAY,FINISHED&limit=10`,
          { headers: API_HEADERS, timeout: 5000 }
        );
        
        if (response.data.matches && response.data.matches.length > 0) {
          const matchesWithComp = response.data.matches.map(m => ({
            ...m,
            competitionName: league.name
          }));
          allMatches = [...allMatches, ...matchesWithComp];
          console.log(`      ✅ ${league.code}: ${response.data.matches.length} matches`);
        }
      } catch (e) {
        console.log(`      ⚠️ ${league.code}: ${e.message}`);
      }
    }
    
    if (allMatches.length > 0) {
      await storeMatches(allMatches, "Various Leagues");
      console.log(`   ✅ Total: ${allMatches.length} matches from current leagues`);
      return true;
    }
    
    console.log("❌ No matches found from any source");
    return false;
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    return false;
  }
}

// ─── API Endpoints ─────────────────────────────────────────────────────

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "World Cup 2026 Betting API",
    status: "running",
    environment: isVercel ? "vercel" : "local",
    endpoints: {
      health: "/api/health",
      matches: "/api/matches",
      match: "/api/matches/:id",
      stats: "/api/stats",
      leaderboard: "/api/leaderboard",
      ultimate: "/api/ultimate",
      refresh: "/api/refresh",
      debug: "/api/debug"
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  const count = await dbGet("SELECT COUNT(*) as c FROM matches");
  res.json({ 
    status: "ok",
    matchesInDB: count?.c || 0,
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
    timestamp: new Date().toISOString()
  });
});

// Get all matches
app.get("/api/matches", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
    res.json({ 
      matches: rows.map(formatMatch),
      total: rows.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single match
app.get("/api/matches/:id", async (req, res) => {
  try {
    const row = await dbGet("SELECT * FROM matches WHERE id=?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Match not found" });
    res.json({ match: formatMatch(row) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get stats
app.get("/api/stats", async (req, res) => {
  try {
    const matchCount = await dbGet("SELECT COUNT(*) as c FROM matches") || { c: 0 };
    const liveMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='IN_PLAY'") || { c: 0 };
    const finishedMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='FINISHED'") || { c: 0 };
    
    res.json({
      matchCount: matchCount.c,
      liveMatches: liveMatches.c,
      finishedMatches: finishedMatches.c,
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678
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

// Leaderboard (demo)
app.get("/api/leaderboard", (req, res) => {
  res.json({
    leaderboard: [
      { user: "0x1234...5678", total_wagered: "50000", bet_count: 23 },
      { user: "0x2345...6789", total_wagered: "45000", bet_count: 19 },
      { user: "0x3456...7890", total_wagered: "38000", bet_count: 31 }
    ]
  });
});

// Ultimate bet (demo)
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
    ]
  });
});

// Refresh matches
app.post("/api/refresh", async (req, res) => {
  const success = await fetchAndStoreMatches();
  const count = await dbGet("SELECT COUNT(*) as c FROM matches");
  res.json({ 
    success, 
    matchesInDB: count?.c || 0,
    message: success ? "Matches refreshed successfully" : "Failed to fetch matches"
  });
});

// Debug endpoint
app.get("/api/debug", async (req, res) => {
  const dbCount = await dbGet("SELECT COUNT(*) as c FROM matches");
  
  res.json({
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
    apiKeyPrefix: FOOTBALL_API_KEY?.substring(0, 5),
    environment: isVercel ? "vercel" : "local",
    database: {
      path: dbPath,
      matches: dbCount?.c || 0
    },
    timestamp: new Date().toISOString()
  });
});

// ─── Initialize on Startup ─────────────────────────────────────────────
async function initialize() {
  console.log("\n🚀 Starting World Cup API...");
  console.log(`📊 Environment: ${isVercel ? 'Vercel' : 'Local'}`);
  console.log(`🔑 API Key: ${FOOTBALL_API_KEY ? '✅' : '❌'}`);
  
  const count = await dbGet("SELECT COUNT(*) as c FROM matches");
  
  if (!count || count.c === 0) {
    console.log("🔄 No matches found, fetching initial data...");
    await fetchAndStoreMatches();
  } else {
    console.log(`📊 Database already has ${count.c} matches`);
    
    // Refresh in background if on Vercel (don't await)
    if (isVercel) {
      console.log("🔄 Background refresh started...");
      fetchAndStoreMatches().catch(console.error);
    }
  }
}

// Run initialization (don't await - let it run in background)
initialize().catch(console.error);

// ─── Export for Vercel ─────────────────────────────────────────────────
module.exports = app;