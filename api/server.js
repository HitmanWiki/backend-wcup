/**
 * World Cup 2026 Betting — Backend API
 * ONLY fetches World Cup data - NO DEMO, NO OTHER LEAGUES
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
const API_HEADERS = { "X-Auth-Token": FOOTBALL_API_KEY };

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

// ─── Fetch ONLY World Cup matches ─────────────────────────────────────────
async function fetchWorldCupMatches() {
  console.log("🌍 Fetching World Cup matches from football-data.org...");
  
  try {
    const response = await axios.get(
      `${API_BASE}/competitions/WC/matches`,
      { 
        headers: API_HEADERS,
        timeout: 10000
      }
    );
    
    const matches = response.data.matches || [];
    console.log(`✅ Found ${matches.length} World Cup matches`);
    
    if (matches.length > 0) {
      // Log first match as sample
      const sample = matches[0];
      console.log(`   Sample: ${sample.homeTeam?.name} vs ${sample.awayTeam?.name} (${sample.status})`);
    }
    
    return matches;
    
  } catch (error) {
    console.error("❌ Failed to fetch World Cup data:", error.response?.data || error.message);
    throw error;
  }
}

// ─── Store matches in database ────────────────────────────────────────────
async function storeMatches(matches) {
  // Clear existing matches
  await dbRun("DELETE FROM matches");
  
  if (matches.length === 0) {
    console.log("⚠️ No matches to store");
    return 0;
  }
  
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
    } catch (e) {
      console.log(`   ⚠️ Skipping duplicate match: ${match.id}`);
    }
  }
  
  console.log(`✅ Stored ${stored} World Cup matches in database`);
  return stored;
}

// ─── Format match for API response ────────────────────────────────────────
function formatMatch(row) {
  // Generate random pools for demo (since no blockchain)
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

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    res.json({ 
      status: "ok", 
      message: "World Cup 2026 API",
      matchesInDB: count?.c || 0,
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ 
      status: "ok", 
      message: "World Cup 2026 API",
      matchesInDB: 0,
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌"
    });
  }
});

// GET /api/matches - Returns World Cup matches
app.get("/api/matches", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
    res.json({ 
      matches: rows.map(formatMatch),
      total: rows.length,
      source: "World Cup 2026 Data"
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
      matchCount: matchCount.c,
      liveMatches: liveMatches.c,
      finishedMatches: finishedMatches.c,
      totalVolumeCLUTCH: "0",
      uniqueUsers: 0,
      totalBets: 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/leaderboard (placeholder)
app.get("/api/leaderboard", (req, res) => {
  res.json({ leaderboard: [] });
});

// GET /api/ultimate (placeholder)
app.get("/api/ultimate", (req, res) => {
  res.json({
    deadline: null,
    settled: false,
    winner: null,
    totalPool: "0",
    teamPools: []
  });
});

// POST /api/refresh - Manually fetch World Cup data
app.post("/api/refresh", async (req, res) => {
  try {
    const matches = await fetchWorldCupMatches();
    const stored = await storeMatches(matches);
    res.json({ 
      success: true, 
      message: `Fetched ${matches.length} matches, stored ${stored}`,
      matches: matches.length
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ─── Initialize on cold start ─────────────────────────────────────────────
async function initialize() {
  try {
    // Check if we have matches
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    
    if (!count || count.c === 0) {
      console.log("🔄 No matches found, fetching World Cup data...");
      try {
        const matches = await fetchWorldCupMatches();
        await storeMatches(matches);
      } catch (error) {
        console.error("❌ Failed to fetch World Cup data on init:", error.message);
      }
    } else {
      console.log(`📊 Database already has ${count.c} World Cup matches`);
    }
  } catch (error) {
    console.error("Error initializing:", error);
  }
}

// Run initialization
initialize();

// ─── Export for Vercel ────────────────────────────────────────────────────
module.exports = app;