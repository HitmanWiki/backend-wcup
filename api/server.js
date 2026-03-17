/**
 * World Cup 2026 Betting — Backend API
 * Complete version with debug endpoints
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

// ─── Demo matches with real team names (fallback) ─────────────────────────
function getDemoMatches() {
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      id: 1,
      utcDate: new Date(now * 1000 + 86400000).toISOString(),
      homeTeam: { name: "USA" },
      awayTeam: { name: "Mexico" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    },
    {
      id: 2,
      utcDate: new Date(now * 1000 + 172800000).toISOString(),
      homeTeam: { name: "Brazil" },
      awayTeam: { name: "Argentina" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    },
    {
      id: 3,
      utcDate: new Date(now * 1000 - 86400000).toISOString(),
      homeTeam: { name: "Germany" },
      awayTeam: { name: "France" },
      status: "FINISHED",
      score: { fullTime: { home: 2, away: 1 } }
    },
    {
      id: 4,
      utcDate: new Date(now * 1000 - 3600000).toISOString(),
      homeTeam: { name: "England" },
      awayTeam: { name: "Spain" },
      status: "IN_PLAY",
      score: { fullTime: { home: 1, away: 0 } }
    },
    {
      id: 5,
      utcDate: new Date(now * 1000 + 259200000).toISOString(),
      homeTeam: { name: "France" },
      awayTeam: { name: "Portugal" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    },
    {
      id: 6,
      utcDate: new Date(now * 1000 + 345600000).toISOString(),
      homeTeam: { name: "Netherlands" },
      awayTeam: { name: "Belgium" },
      status: "SCHEDULED",
      score: { fullTime: { home: null, away: null } }
    }
  ];
}

// ─── Fetch matches from API ───────────────────────────────────────────────
async function fetchAndStoreMatches() {
  try {
    console.log("📡 Fetching matches from football-data.org...");
    
    let matches = [];
    let usedCode = null;
    
    const codesToTry = ['WC', 'PL', 'PD', 'BL1', 'SA', 'FL1', 'CL'];
    
    for (const code of codesToTry) {
      try {
        console.log(`   Trying competition code: ${code}...`);
        const response = await axios.get(
          `${API_BASE}/competitions/${code}/matches?status=SCHEDULED,IN_PLAY,FINISHED&limit=50`,
          { headers: API_HEADERS, timeout: 8000 }
        );
        
        if (response.data.matches && response.data.matches.length > 0) {
          matches = response.data.matches;
          usedCode = code;
          console.log(`   ✅ Found ${matches.length} matches with code ${code}`);
          break;
        } else {
          console.log(`   ℹ️ ${code} returned 0 matches`);
        }
      } catch (e) {
        console.log(`   ⚠️ ${code}: ${e.message}`);
        if (e.response) {
          console.log(`      Status: ${e.response.status}`);
        }
        continue;
      }
    }
    
    // If no matches from API, use demo matches
    if (matches.length === 0) {
      console.log("⚠️ No matches found from API, using demo matches");
      matches = getDemoMatches();
    } else {
      console.log(`✅ Successfully fetched ${matches.length} matches from ${usedCode}`);
    }
    
    // Clear existing matches
    await dbRun("DELETE FROM matches");
    console.log("🗑️ Cleared existing matches");
    
    // Store in database
    let stored = 0;
    for (const match of matches) {
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
           (id, home_team, away_team, start_time, status, home_score, away_score, winner)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [match.id, homeTeam, awayTeam, startTime, status, homeScore, awayScore, winner]
        );
        stored++;
        if (stored % 20 === 0) {
          console.log(`   Progress: ${stored}/${matches.length} matches stored`);
        }
      } catch (e) {
        console.log(`   ⚠️ Error storing match ${match.id}: ${e.message}`);
      }
    }
    
    console.log(`💾 Successfully stored ${stored} matches in database`);
    
    // Verify storage
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    console.log(`📊 Database now has ${count.c} matches`);
    
  } catch (error) {
    console.error("❌ Error in fetchAndStoreMatches:", error.message);
    
    // Fallback to demo matches
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    if (!count || count.c === 0) {
      console.log("📋 Using demo matches as fallback");
      const matches = getDemoMatches();
      for (const match of matches) {
        const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
        const homeScore = match.score?.fullTime?.home || 0;
        const awayScore = match.score?.fullTime?.away || 0;
        const winner = match.status === "FINISHED" && homeScore > awayScore ? match.homeTeam.name : 
                      match.status === "FINISHED" && awayScore > homeScore ? match.awayTeam.name : null;
        
        await dbRun(
          `INSERT OR REPLACE INTO matches 
           (id, home_team, away_team, start_time, status, home_score, away_score, winner)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [match.id, match.homeTeam.name, match.awayTeam.name, startTime,
           match.status, homeScore, awayScore, winner]
        );
      }
      console.log("💾 Stored demo matches");
    }
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
      debug: "/api/debug",
      "debug-fetch": "/api/debug-fetch",
      "force-demo": "/api/force-demo"
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    res.json({ 
      status: "ok",
      matchesInDB: count?.c || 0,
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
      environment: isVercel ? "vercel" : "local",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ 
      status: "ok", 
      matchesInDB: 0,
      error: error.message
    });
  }
});

// GET /api/matches
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
    const matchCount = await dbGet("SELECT COUNT(*) as c FROM matches") || { c: 0 };
    const liveMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='IN_PLAY'") || { c: 0 };
    const finishedMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='FINISHED'") || { c: 0 };
    
    res.json({
      totalMatches: matchCount.c,
      liveMatches: liveMatches.c,
      finishedMatches: finishedMatches.c,
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678
    });
  } catch (error) {
    res.json({
      totalMatches: 0,
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

// 🔍 DEBUG ENDPOINT - Test API connectivity
app.get("/api/debug-fetch", async (req, res) => {
  const results = {
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
    apiKeyPrefix: FOOTBALL_API_KEY ? FOOTBALL_API_KEY.substring(0, 8) + "..." : "none",
    timestamp: new Date().toISOString(),
    tests: {},
    database: {}
  };
  
  // Test each competition
  const codes = ['WC', 'PL', 'PD', 'BL1', 'SA', 'FL1', 'CL'];
  
  for (const code of codes) {
    try {
      const start = Date.now();
      const response = await axios.get(
        `${API_BASE}/competitions/${code}`,
        { headers: API_HEADERS, timeout: 5000 }
      );
      results.tests[code] = {
        success: true,
        time: Date.now() - start + 'ms',
        competition: response.data.name,
        plan: response.data.plan,
        available: true
      };
    } catch (e) {
      results.tests[code] = {
        success: false,
        error: e.message,
        status: e.response?.status,
        statusText: e.response?.statusText
      };
    }
  }
  
  // Test matches endpoint for WC
  try {
    const matchResponse = await axios.get(
      `${API_BASE}/competitions/WC/matches`,
      { headers: API_HEADERS, timeout: 5000 }
    );
    results.wcMatches = {
      total: matchResponse.data.matches?.length || 0,
      competition: matchResponse.data.competition?.name,
      season: matchResponse.data.season
    };
  } catch (e) {
    results.wcMatches = {
      error: e.message,
      status: e.response?.status
    };
  }
  
  // Check database
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    const sample = await dbGet("SELECT * FROM matches LIMIT 1");
    results.database = {
      matches: count?.c || 0,
      hasSample: !!sample,
      sampleMatch: sample ? {
        id: sample.id,
        home: sample.home_team,
        away: sample.away_team
      } : null
    };
  } catch (e) {
    results.database = {
      error: e.message
    };
  }
  
  res.json(results);
});

// 🚀 FORCE DEMO - Force load demo matches
app.post("/api/force-demo", async (req, res) => {
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
  
  const count = await dbGet("SELECT COUNT(*) as c FROM matches");
  res.json({ 
    success: true, 
    message: "Demo matches loaded",
    matchesInDB: count.c
  });
});

// 🔄 Refresh matches
app.post("/api/refresh", async (req, res) => {
  res.json({ message: "Refresh started - check logs" });
  // Don't await - let it run in background
  fetchAndStoreMatches().catch(console.error);
});

// ─── Initialize on cold start ─────────────────────────────────────────────
async function initialize() {
  console.log("\n🚀 Starting World Cup API...");
  console.log(`📊 Environment: ${isVercel ? 'Vercel' : 'Local'}`);
  console.log(`🔑 API Key: ${FOOTBALL_API_KEY ? '✅' : '❌'}`);
  console.log(`📁 Database: ${dbPath}`);
  
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    console.log(`📊 Current matches in DB: ${count?.c || 0}`);
    
    if (!count || count.c === 0) {
      console.log("🔄 No matches found, fetching initial data...");
      await fetchAndStoreMatches();
    } else {
      console.log(`✅ Database already has ${count.c} matches`);
    }
  } catch (error) {
    console.error("❌ Error initializing:", error);
    console.log("📋 Loading demo matches as fallback...");
    const matches = getDemoMatches();
    for (const match of matches) {
      const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
      const homeScore = match.score?.fullTime?.home || 0;
      const awayScore = match.score?.fullTime?.away || 0;
      const winner = match.status === "FINISHED" && homeScore > awayScore ? match.homeTeam.name : 
                    match.status === "FINISHED" && awayScore > homeScore ? match.awayTeam.name : null;
      
      await dbRun(
        `INSERT OR REPLACE INTO matches 
         (id, home_team, away_team, start_time, status, home_score, away_score, winner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [match.id, match.homeTeam.name, match.awayTeam.name, startTime,
         match.status, homeScore, awayScore, winner]
      );
    }
    console.log("✅ Loaded demo matches");
  }
}

// Run initialization
initialize().catch(console.error);

// ─── Export for Vercel ────────────────────────────────────────────────────
module.exports = app;