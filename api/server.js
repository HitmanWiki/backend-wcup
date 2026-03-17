/**
 * World Cup 2026 Betting — Backend API
 * EXACT same logic as your local working version
 * Adapted for Vercel deployment
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose(); // Changed from better-sqlite3

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const isVercel = process.env.VERCEL === '1';

// ─── DB Setup for Vercel ──────────────────────────────────────────────────
const dbPath = isVercel ? '/tmp/worldcup.db' : './worldcup.db';
const db = new sqlite3.Database(dbPath);

// Promisify database operations to match better-sqlite3's sync style
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

// Initialize database (runs once)
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
const API_HEADERS = {
  "X-Auth-Token": FOOTBALL_API_KEY
};

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

// ─── Fetch matches from API ───────────────────────────────────────────────
async function fetchAndStoreMatches() {
  try {
    console.log("📡 Fetching matches from football-data.org...");
    
    let matches = [];
    let usedCode = null;
    
    // Try World Cup first, then other competitions
    const codesToTry = ['WC', 'CL', 'PL', 'BL1', 'PD', 'SA', 'FL1'];
    
    for (const code of codesToTry) {
      try {
        console.log(`   Trying competition code: ${code}...`);
        const response = await axios.get(
          `${API_BASE}/competitions/${code}/matches?status=SCHEDULED,IN_PLAY,FINISHED`,
          { headers: API_HEADERS, timeout: 10000 }
        );
        
        if (response.data.matches && response.data.matches.length > 0) {
          matches = response.data.matches;
          usedCode = code;
          console.log(`   ✅ Found ${matches.length} matches with code ${code}`);
          break;
        }
      } catch (e) {
        console.log(`   ⚠️ ${code}: ${e.message}`);
        continue;
      }
    }
    
    if (matches.length === 0) {
      console.log("❌ No matches found from API");
      return;
    }
    
    console.log(`✅ Successfully fetched ${matches.length} matches from ${usedCode}`);
    
    // Clear existing matches and insert new ones
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
        console.log(`   ⚠️ Skipping duplicate match: ${match.id}`);
      }
    }
    
    console.log(`💾 Stored ${stored} matches in database`);
    
  } catch (error) {
    console.error("Error fetching matches:", error.message);
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
    bettingOpen: row.status === "SCHEDULED" || row.status === "TIMED"
  };
}

// ─── Express App ───────────────────────────────────────────────────────────

// GET /api/matches
app.get("/api/matches", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM matches ORDER BY start_time ASC");
    res.json({ matches: rows.map(formatMatch) });
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
    const matchCount = await dbGet("SELECT COUNT(*) as c FROM matches");
    const liveMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='IN_PLAY'");
    const finishedMatches = await dbGet("SELECT COUNT(*) as c FROM matches WHERE status='FINISHED'");
    
    res.json({
      matchCount: matchCount?.c || 0,
      liveMatches: liveMatches?.c || 0,
      finishedMatches: finishedMatches?.c || 0,
      totalVolumeCLUTCH: "125000",
      uniqueUsers: 1243,
      totalBets: 5678
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/leaderboard
app.get("/api/leaderboard", (req, res) => {
  const demoLeaderboard = [
    { user: "0x1234...5678", total_wagered: "50000", bet_count: 23 },
    { user: "0x2345...6789", total_wagered: "45000", bet_count: 19 },
    { user: "0x3456...7890", total_wagered: "38000", bet_count: 31 },
    { user: "0x4567...8901", total_wagered: "29000", bet_count: 15 },
    { user: "0x5678...9012", total_wagered: "21000", bet_count: 12 }
  ];
  res.json({ leaderboard: demoLeaderboard });
});

// GET /api/ultimate
app.get("/api/ultimate", (req, res) => {
  const teams = [
    { team: "Brazil", amount: "45000" },
    { team: "Argentina", amount: "38000" },
    { team: "France", amount: "32000" },
    { team: "Germany", amount: "28000" },
    { team: "England", amount: "25000" }
  ];
  
  res.json({
    deadline: Math.floor(Date.now() / 1000) + 2592000,
    settled: false,
    winner: null,
    totalPool: "168000",
    teamPools: teams
  });
});

// GET /api/health
app.get("/api/health", async (req, res) => {
  const count = await dbGet("SELECT COUNT(*) as c FROM matches");
  res.json({ 
    status: "ok", 
    matches: count?.c || 0,
    vercel: isVercel,
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌"
  });
});

// ─── Initialize on cold start ─────────────────────────────────────────────
async function initialize() {
  const count = await dbGet("SELECT COUNT(*) as c FROM matches");
  if (!count || count.c === 0) {
    console.log("🔄 No matches found, fetching...");
    await fetchAndStoreMatches();
  } else {
    console.log(`📊 Database has ${count.c} matches`);
  }
}

// Run initialization (don't await - let it run in background)
initialize().catch(console.error);

// ─── Export for Vercel ────────────────────────────────────────────────────
module.exports = app;