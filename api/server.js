/**
 * World Cup 2026 Betting — Backend API
 * Fixed timeout issues for Vercel
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

// ─── Demo matches (always available fallback) ─────────────────────────────
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
  console.log("💾 Stored demo matches");
}

// ─── Fetch matches from API with better timeout handling ──────────────────
async function fetchAndStoreMatches() {
  try {
    console.log("📡 Fetching matches from football-data.org...");
    
    // If no API key, use demo matches immediately
    if (!FOOTBALL_API_KEY) {
      console.log("⚠️ No API key found, using demo matches");
      await storeDemoMatches();
      return;
    }
    
    const codesToTry = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL']; // Most likely to have data
    let matches = [];
    let usedCode = null;
    
    // Try each competition with individual timeouts
    for (const code of codesToTry) {
      try {
        console.log(`   Fetching ${code}...`);
        
        // Use Promise.race to implement timeout
        const fetchPromise = axios.get(
          `${API_BASE}/competitions/${code}/matches?status=SCHEDULED,IN_PLAY,FINISHED&limit=10`,
          { 
            headers: API_HEADERS,
            timeout: 3000 // 3 second timeout per request
          }
        );
        
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), 3000);
        });
        
        const response = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (response.data.matches && response.data.matches.length > 0) {
          matches = response.data.matches.slice(0, 15); // Limit to 15 matches per league
          usedCode = code;
          console.log(`   ✅ Found ${matches.length} matches in ${code}`);
          break; // Stop after first successful fetch
        }
      } catch (e) {
        console.log(`   ⚠️ ${code}: ${e.message}`);
        continue;
      }
    }
    
    // If API fetch failed, use demo matches
    if (matches.length === 0) {
      console.log("⚠️ No matches from API, using demo matches");
      await storeDemoMatches();
      return;
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
    
    console.log(`✅ Stored ${stored} matches from ${usedCode}`);
    
  } catch (error) {
    console.error("Error in fetchAndStoreMatches:", error.message);
    // Always have demo matches as fallback
    await storeDemoMatches();
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

// GET /api/matches
app.get("/api/matches", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
    
    // If no matches, initialize with demo data
    if (rows.length === 0) {
      await storeDemoMatches();
      const newRows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
      return res.json({ matches: newRows.map(formatMatch) });
    }
    
    res.json({ matches: rows.map(formatMatch) });
  } catch (error) {
    console.error("Error in /api/matches:", error);
    // Return empty array on error
    res.json({ matches: [] });
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
      totalMatches: matchCount.c || 0,
      liveMatches: liveMatches.c || 0,
      finishedMatches: finishedMatches.c || 0,
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678
    });
  } catch (error) {
    // Return default stats on error
    res.json({
      totalMatches: 6,
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
      { user: "0x3456...7890", total_wagered: "38000", bet_count: 31 }
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
      { team: "France", amount: "32000" }
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

// GET /api/debug - Force demo data
app.get("/api/debug", async (req, res) => {
  await storeDemoMatches();
  const rows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
  res.json({ 
    message: "Demo data loaded",
    matches: rows.length,
    data: rows.map(formatMatch)
  });
});

// ─── Initialize on cold start ─────────────────────────────────────────────
async function initialize() {
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    if (!count || count.c === 0) {
      console.log("🔄 No matches found, initializing with demo data...");
      await storeDemoMatches();
    }
  } catch (error) {
    console.error("Error initializing:", error);
    await storeDemoMatches();
  }
}

// Run initialization
initialize();

// ─── Export for Vercel ────────────────────────────────────────────────────
module.exports = app;