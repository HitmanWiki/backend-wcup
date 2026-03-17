/**
 * World Cup 2026 Betting — Backend API
 * Uses pre-populated database from local
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const isVercel = process.env.VERCEL === '1';

// ─── Database Setup ──────────────────────────────────────────────────────
let dbPath;

if (isVercel) {
  // On Vercel: Copy the pre-populated DB from the build directory to /tmp
  const sourceDb = path.join(__dirname, '../db/worldcup.db');
  const destDb = '/tmp/worldcup.db';
  
  // Copy the database file if it exists
  if (fs.existsSync(sourceDb)) {
    fs.copyFileSync(sourceDb, destDb);
    console.log("✅ Copied pre-populated database to /tmp");
  } else {
    console.log("⚠️ Source database not found, using empty database");
  }
  
  dbPath = destDb;
} else {
  // Local development
  dbPath = './worldcup.db';
}

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

// ─── API Endpoints ─────────────────────────────────────────────────────

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "World Cup 2026 Betting API",
    status: "running",
    environment: isVercel ? "vercel" : "local",
    database: "pre-populated with 104 World Cup matches",
    endpoints: {
      health: "/api/health",
      matches: "/api/matches",
      match: "/api/matches/:id",
      stats: "/api/stats",
      leaderboard: "/api/leaderboard",
      ultimate: "/api/ultimate"
    }
  });
});

// Health check
app.get("/api/health", async (req, res) => {
  const count = await dbGet("SELECT COUNT(*) as c FROM matches");
  res.json({ 
    status: "ok",
    matchesInDB: count?.c || 0,
    source: count?.c > 0 ? "Pre-populated database" : "Empty database",
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
      total: rows.length,
      source: rows.length > 0 ? "Pre-populated World Cup data" : "No matches"
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

// Debug endpoint
app.get("/api/debug", async (req, res) => {
  const dbCount = await dbGet("SELECT COUNT(*) as c FROM matches");
  
  // Get sample match
  const sample = await dbGet("SELECT * FROM matches LIMIT 1");
  
  res.json({
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
    environment: isVercel ? "vercel" : "local",
    database: {
      path: dbPath,
      matches: dbCount?.c || 0,
      sampleMatch: sample || null
    },
    timestamp: new Date().toISOString()
  });
});

// ─── Export for Vercel ─────────────────────────────────────────────────
module.exports = app;