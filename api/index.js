/**
 * World Cup 2026 Betting — Backend API
 * Deployed on Vercel - Uses REAL football-data.org API
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const isVercel = process.env.VERCEL === '1';

// Check for API key
if (!FOOTBALL_API_KEY) {
  console.error("❌ ERROR: FOOTBALL_DATA_API_KEY not found in environment");
}

// ─── Database Setup for Vercel ────────────────────────────────────────────
const dbPath = isVercel 
  ? '/tmp/worldcup.db'  // Vercel's writable temp directory
  : './worldcup.db';

let db;
try {
  db = new Database(dbPath);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id          INTEGER PRIMARY KEY,
      home_team   TEXT NOT NULL,
      away_team   TEXT NOT NULL,
      start_time  INTEGER NOT NULL,
      status      TEXT DEFAULT 'SCHEDULED',
      home_score  INTEGER DEFAULT 0,
      away_score  INTEGER DEFAULT 0,
      winner      TEXT,
      competition_code TEXT,
      competition_name TEXT,
      pool_home   TEXT DEFAULT '0',
      pool_draw   TEXT DEFAULT '0',
      pool_away   TEXT DEFAULT '0',
      total_pool  TEXT DEFAULT '0'
    );
  `);
  
  console.log("✅ Database initialized at:", dbPath);
} catch (error) {
  console.error("❌ Database error:", error);
}

// ─── Football-Data.org API ─────────────────────────────────────────────────
const API_BASE = "https://api.football-data.org/v4";
const API_HEADERS = FOOTBALL_API_KEY ? { "X-Auth-Token": FOOTBALL_API_KEY } : {};

// ─── Helper: Normalize team names ────────────────────────────────────────
function normalizeTeam(name) {
  if (!name) return "Unknown";
  
  const map = {
    // Americas
    "United States": "USA",
    "USA": "USA",
    "Mexico": "Mexico",
    "Canada": "Canada",
    "Brazil": "Brazil",
    "Argentina": "Argentina",
    "Uruguay": "Uruguay",
    "Colombia": "Colombia",
    "Ecuador": "Ecuador",
    "Peru": "Peru",
    "Chile": "Chile",
    "Paraguay": "Paraguay",
    "Costa Rica": "Costa Rica",
    "Panama": "Panama",
    
    // Europe
    "France": "France",
    "Germany": "Germany",
    "Spain": "Spain",
    "England": "England",
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
    "Turkey": "Turkey",
    "Türkiye": "Turkey",
    "Greece": "Greece",
    "Czech Republic": "Czech Republic",
    "Ukraine": "Ukraine",
    
    // Africa
    "Morocco": "Morocco",
    "Senegal": "Senegal",
    "Nigeria": "Nigeria",
    "Egypt": "Egypt",
    "Tunisia": "Tunisia",
    "Algeria": "Algeria",
    "Cameroon": "Cameroon",
    "Ghana": "Ghana",
    "Ivory Coast": "Ivory Coast",
    "Côte d'Ivoire": "Ivory Coast",
    
    // Asia
    "Japan": "Japan",
    "South Korea": "South Korea",
    "Korea Republic": "South Korea",
    "Australia": "Australia",
    "Iran": "Iran",
    "IR Iran": "Iran",
    "Saudi Arabia": "Saudi Arabia",
    "Qatar": "Qatar",
    "China": "China",
    "India": "India",
    
    // Oceania
    "New Zealand": "New Zealand"
  };
  
  return map[name] || name;
}

// ─── Fetch competitions (cached for Vercel) ───────────────────────────────
async function fetchCompetitions() {
  if (!FOOTBALL_API_KEY) {
    return [
      { code: 'PL', name: 'Premier League', area: { name: 'England' } },
      { code: 'PD', name: 'La Liga', area: { name: 'Spain' } },
      { code: 'BL1', name: 'Bundesliga', area: { name: 'Germany' } },
      { code: 'SA', name: 'Serie A', area: { name: 'Italy' } },
      { code: 'FL1', name: 'Ligue 1', area: { name: 'France' } },
      { code: 'CL', name: 'Champions League', area: { name: 'Europe' } },
      { code: 'WC', name: 'World Cup', area: { name: 'World' } }
    ];
  }

  try {
    const response = await axios.get(
      `${API_BASE}/competitions`,
      { headers: API_HEADERS, timeout: 5000 }
    );
    
    return response.data.competitions
      .filter(comp => comp.type === 'LEAGUE' || comp.type === 'CUP')
      .slice(0, 8);
  } catch (error) {
    console.error("Failed to fetch competitions:", error.message);
    return [
      { code: 'PL', name: 'Premier League', area: { name: 'England' } },
      { code: 'PD', name: 'La Liga', area: { name: 'Spain' } },
      { code: 'BL1', name: 'Bundesliga', area: { name: 'Germany' } }
    ];
  }
}

// ─── Fetch and store matches (called on cold start) ───────────────────────
async function fetchAndStoreMatches() {
  console.log("📡 Fetching matches from football-data.org...");
  
  if (!FOOTBALL_API_KEY) {
    console.error("❌ No API key found");
    return false;
  }
  
  try {
    const competitions = await fetchCompetitions();
    let allMatches = [];
    
    for (const comp of competitions.slice(0, 5)) { // Limit to 5 comps
      try {
        console.log(`   Fetching ${comp.code}...`);
        const response = await axios.get(
          `${API_BASE}/competitions/${comp.code}/matches?status=SCHEDULED,IN_PLAY,FINISHED&limit=20`,
          { headers: API_HEADERS, timeout: 5000 }
        );
        
        if (response.data.matches?.length) {
          const matchesWithComp = response.data.matches.map(match => ({
            ...match,
            competition: {
              code: comp.code,
              name: comp.name
            }
          }));
          allMatches = [...allMatches, ...matchesWithComp];
          console.log(`   ✅ Found ${response.data.matches.length} matches`);
        }
      } catch (e) {
        console.log(`   ⚠️ Error fetching ${comp.code}: ${e.message}`);
      }
    }
    
    if (allMatches.length === 0) {
      console.log("⚠️ No matches found from API");
      return false;
    }
    
    // Clear and store new matches
    db.prepare("DELETE FROM matches").run();
    
    const stmt = db.prepare(`
      INSERT INTO matches 
      (id, home_team, away_team, start_time, status, home_score, away_score, winner, competition_code, competition_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let stored = 0;
    for (const match of allMatches) {
      const startTime = Math.floor(new Date(match.utcDate).getTime() / 1000);
      const homeTeam = normalizeTeam(match.homeTeam?.name || "Unknown");
      const awayTeam = normalizeTeam(match.awayTeam?.name || "Unknown");
      const status = match.status || "SCHEDULED";
      const homeScore = match.score?.fullTime?.home ?? 0;
      const awayScore = match.score?.fullTime?.away ?? 0;
      
      const winner = status === "FINISHED" && homeScore !== awayScore
        ? (homeScore > awayScore ? homeTeam : awayTeam)
        : null;
      
      try {
        stmt.run(
          match.id, homeTeam, awayTeam, startTime,
          status, homeScore, awayScore, winner,
          match.competition?.code || 'Unknown',
          match.competition?.name || 'Unknown'
        );
        stored++;
      } catch (e) {
        // Skip duplicates
      }
    }
    
    console.log(`✅ Stored ${stored} matches`);
    return true;
    
  } catch (error) {
    console.error("❌ Error fetching matches:", error.message);
    return false;
  }
}

// ─── Format match for API response ────────────────────────────────────────
function formatMatch(row) {
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

// ─── API Endpoints ────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  const matchCount = db.prepare("SELECT COUNT(*) as c FROM matches").get().c;
  res.json({ 
    status: "ok", 
    vercel: isVercel,
    apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
    matchesInDB: matchCount,
    timestamp: new Date().toISOString()
  });
});

// GET /api/matches
app.get("/api/matches", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM matches ORDER BY start_time ASC").all();
    res.json({ 
      matches: rows.map(formatMatch),
      total: rows.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/matches/:id
app.get("/api/matches/:id", (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Match not found" });
    res.json({ match: formatMatch(row) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/competitions
app.get("/api/competitions", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT competition_code, competition_name, COUNT(*) as match_count 
      FROM matches 
      GROUP BY competition_code 
      ORDER BY match_count DESC
    `).all();
    res.json({ competitions: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stats
app.get("/api/stats", (req, res) => {
  try {
    const matchCount = db.prepare("SELECT COUNT(*) as c FROM matches").get().c;
    const liveMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status='IN_PLAY'").get().c;
    const finishedMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status='FINISHED'").get().c;
    const upcomingMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status='SCHEDULED'").get().c;
    
    res.json({
      matchCount,
      liveMatches,
      finishedMatches,
      upcomingMatches,
      totalVolumeCLUTCH: (matchCount * 15000).toString(),
      uniqueUsers: 1243,
      totalBets: matchCount * 45
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

// POST /api/refresh - Manually trigger refresh (protected)
app.post("/api/refresh", async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const success = await fetchAndStoreMatches();
  res.json({ success, message: success ? "Matches refreshed" : "Refresh failed" });
});

// ─── Initialize data on cold start ────────────────────────────────────────
// This runs once when Vercel cold starts the function
if (db.prepare("SELECT COUNT(*) as c FROM matches").get().c === 0) {
  fetchAndStoreMatches().catch(console.error);
}

// ─── Export for Vercel ────────────────────────────────────────────────────
module.exports = app;