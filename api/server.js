/**
 * World Cup 2026 Betting — Backend API
 * Complete with AI Analysis Endpoints
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
      competition_code TEXT,
      competition_name TEXT,
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

// ─── AI Analysis Agent Class ─────────────────────────────────────────────
class AIAnalysisAgent {
  constructor(apiKey) {
    this.footballApiKey = apiKey;
    this.apiBase = "https://api.football-data.org/v4";
    this.headers = { "X-Auth-Token": this.footballApiKey };
  }

  // ─── Fetch Head-to-Head History ──────────────────────────────────────
  async getHeadToHead(team1, team2) {
    try {
      console.log(`📊 Analyzing head-to-head: ${team1} vs ${team2}`);
      
      const team1Id = await this.findTeamId(team1);
      const team2Id = await this.findTeamId(team2);
      
      if (!team1Id || !team2Id) {
        return {
          totalMatches: 0,
          message: "Could not find team IDs"
        };
      }
      
      const response = await axios.get(
        `${this.apiBase}/teams/${team1Id}/matches?limit=20&status=FINISHED`,
        { headers: this.headers, timeout: 5000 }
      );
      
      const h2hMatches = response.data.matches.filter(m => 
        (m.homeTeam.id === team2Id || m.awayTeam.id === team2Id)
      ).slice(0, 10);
      
      if (h2hMatches.length === 0) {
        return {
          totalMatches: 0,
          message: "No head-to-head history available"
        };
      }
      
      let team1Wins = 0, team2Wins = 0, draws = 0;
      let team1Goals = 0, team2Goals = 0;
      
      h2hMatches.forEach(match => {
        const homeScore = match.score.fullTime.home;
        const awayScore = match.score.fullTime.away;
        
        if (match.homeTeam.id === team1Id) {
          team1Goals += homeScore;
          team2Goals += awayScore;
          if (homeScore > awayScore) team1Wins++;
          else if (homeScore < awayScore) team2Wins++;
          else draws++;
        } else {
          team1Goals += awayScore;
          team2Goals += homeScore;
          if (awayScore > homeScore) team1Wins++;
          else if (awayScore < homeScore) team2Wins++;
          else draws++;
        }
      });
      
      return {
        totalMatches: h2hMatches.length,
        team1Wins,
        team2Wins,
        draws,
        team1Goals,
        team2Goals,
        recentMatches: h2hMatches.slice(0, 5).map(m => ({
          date: new Date(m.utcDate).toLocaleDateString(),
          homeTeam: m.homeTeam.name,
          awayTeam: m.awayTeam.name,
          score: `${m.score.fullTime.home}-${m.score.fullTime.away}`,
          winner: m.score.fullTime.home > m.score.fullTime.away ? m.homeTeam.name :
                  m.score.fullTime.home < m.score.fullTime.away ? m.awayTeam.name : 'Draw'
        })),
        advantage: team1Wins > team2Wins ? team1 : team2Wins > team1Wins ? team2 : 'Equal',
        dominance: ((team1Wins + draws/2) / h2hMatches.length * 100).toFixed(1)
      };
      
    } catch (error) {
      console.error("Error fetching head-to-head:", error.message);
      return {
        totalMatches: 0,
        error: "Could not fetch head-to-head data"
      };
    }
  }

  // ─── Fetch Team Form ────────────────────────────────────────────────
  async getTeamForm(teamName, matches = 5) {
    try {
      console.log(`📈 Analyzing form for: ${teamName}`);
      
      const teamId = await this.findTeamId(teamName);
      if (!teamId) {
        throw new Error("Could not find team ID");
      }
      
      const response = await axios.get(
        `${this.apiBase}/teams/${teamId}/matches?limit=10&status=FINISHED`,
        { headers: this.headers, timeout: 5000 }
      );
      
      const recentMatches = response.data.matches.slice(0, matches);
      
      if (recentMatches.length === 0) {
        return {
          team: teamName,
          message: "No recent matches found"
        };
      }
      
      let form = [];
      let points = 0;
      let goalsFor = 0, goalsAgainst = 0;
      
      recentMatches.forEach(match => {
        const isHome = match.homeTeam.id === teamId;
        const teamScore = isHome ? match.score.fullTime.home : match.score.fullTime.away;
        const opponentScore = isHome ? match.score.fullTime.away : match.score.fullTime.home;
        
        goalsFor += teamScore;
        goalsAgainst += opponentScore;
        
        let result;
        if (teamScore > opponentScore) {
          result = 'W';
          points += 3;
        } else if (teamScore < opponentScore) {
          result = 'L';
        } else {
          result = 'D';
          points += 1;
        }
        
        form.push({
          opponent: isHome ? match.awayTeam.name : match.homeTeam.name,
          result,
          score: `${teamScore}-${opponentScore}`,
          date: new Date(match.utcDate).toLocaleDateString()
        });
      });
      
      const formString = form.map(f => f.result).join('');
      
      return {
        team: teamName,
        recentForm: form,
        formString,
        points,
        goalsFor,
        goalsAgainst,
        averageGoalsFor: (goalsFor / matches).toFixed(1),
        averageGoalsAgainst: (goalsAgainst / matches).toFixed(1),
        formRating: this.calculateFormRating(formString),
        trend: this.analyzeTrend(formString)
      };
      
    } catch (error) {
      console.error("Error fetching team form:", error.message);
      return {
        team: teamName,
        error: "Could not fetch form data"
      };
    }
  }

  // ─── AI Prediction Model ────────────────────────────────────────────
  async predictOutcome(homeTeam, awayTeam) {
    console.log(`🤖 AI predicting: ${homeTeam} vs ${awayTeam}`);
    
    const [h2h, homeForm, awayForm] = await Promise.all([
      this.getHeadToHead(homeTeam, awayTeam),
      this.getTeamForm(homeTeam),
      this.getTeamForm(awayTeam)
    ]);
    
    // Check if we have enough data
    if (homeForm.error || awayForm.error || (h2h.error && h2h.totalMatches === 0)) {
      return {
        prediction: {
          homeWin: 33.3,
          draw: 33.3,
          awayWin: 33.3
        },
        mostLikely: 'UNKNOWN',
        confidence: 'Low',
        insights: ['Insufficient data for accurate prediction'],
        statistics: { h2h, homeForm, awayForm },
        keyFactors: ['Limited historical data available']
      };
    }
    
    const homeAdvantage = 1.2;
    const formWeight = 0.4;
    const h2hWeight = 0.3;
    const recentWeight = 0.3;
    
    const homeFormScore = homeForm.formString ? this.calculateFormScore(homeForm.formString) * homeAdvantage : 50;
    const awayFormScore = awayForm.formString ? this.calculateFormScore(awayForm.formString) : 50;
    
    const h2hScore = h2h.totalMatches > 0 ? 
      (h2h.team1Wins * 3 + h2h.draws) / (h2h.totalMatches * 3) * 100 : 50;
    
    const homeWinProb = (
      homeFormScore * formWeight +
      h2hScore * h2hWeight +
      (100 - awayFormScore) * recentWeight
    ) / (formWeight + h2hWeight + recentWeight);
    
    const awayWinProb = 100 - homeWinProb - 12;
    const drawProb = 12;
    
    const insights = this.generateInsights(homeTeam, awayTeam, {
      h2h, homeForm, awayForm, homeWinProb, awayWinProb, drawProb
    });
    
    return {
      prediction: {
        homeWin: Number(Math.min(homeWinProb, 85).toFixed(1)),
        draw: Number(drawProb.toFixed(1)),
        awayWin: Number(Math.min(awayWinProb, 85).toFixed(1))
      },
      mostLikely: homeWinProb > awayWinProb ? 'HOME_WIN' : awayWinProb > homeWinProb ? 'AWAY_WIN' : 'DRAW',
      confidence: this.calculateConfidence(homeWinProb, awayWinProb, drawProb),
      insights,
      statistics: {
        headToHead: h2h,
        homeTeamForm: homeForm,
        awayTeamForm: awayForm
      },
      keyFactors: this.identifyKeyFactors(h2h, homeForm, awayForm)
    };
  }

  // ─── Helper: Find Team ID ───────────────────────────────────────────
  async findTeamId(teamName) {
    try {
      const response = await axios.get(
        `${this.apiBase}/teams?limit=100`,
        { headers: this.headers, timeout: 5000 }
      );
      
      const team = response.data.teams.find(t => 
        t.name.toLowerCase().includes(teamName.toLowerCase()) ||
        t.shortName?.toLowerCase().includes(teamName.toLowerCase()) ||
        t.tla?.toLowerCase() === teamName.toLowerCase()
      );
      
      return team?.id;
    } catch {
      return null;
    }
  }

  // ─── Helper: Calculate Form Score ───────────────────────────────────
  calculateFormScore(formString) {
    if (!formString) return 50;
    let score = 0;
    for (let i = 0; i < formString.length; i++) {
      const weight = 1 + (i * 0.1);
      if (formString[i] === 'W') score += 3 * weight;
      else if (formString[i] === 'D') score += 1 * weight;
    }
    const maxScore = formString.length * 3 * (1 + (formString.length - 1) * 0.1);
    return (score / maxScore) * 100;
  }

  // ─── Helper: Calculate Form Rating ──────────────────────────────────
  calculateFormRating(formString) {
    if (!formString) return 'Unknown';
    const wins = (formString.match(/W/g) || []).length;
    if (wins >= 4) return 'Excellent';
    if (wins >= 3) return 'Good';
    if (wins >= 2) return 'Average';
    if (wins >= 1) return 'Poor';
    return 'Very Poor';
  }

  // ─── Helper: Analyze Trend ──────────────────────────────────────────
  analyzeTrend(formString) {
    if (!formString) return '↔️ Unknown';
    const last3 = formString.slice(-3);
    if (last3 === 'WWW') return '🚀 Rising sharply';
    if (last3 === 'LLL') return '📉 Declining sharply';
    if (last3.includes('WW')) return '📈 Improving';
    if (last3.includes('LL')) return '📊 Declining';
    return '↔️ Stable';
  }

  // ─── Helper: Generate AI Insights ───────────────────────────────────
  generateInsights(homeTeam, awayTeam, data) {
    const insights = [];
    
    if (data.h2h.totalMatches > 0) {
      if (data.h2h.team1Wins > data.h2h.team2Wins * 2) {
        insights.push(`⚔️ ${homeTeam} dominates historically with ${data.h2h.team1Wins} wins in last ${data.h2h.totalMatches} meetings`);
      } else if (data.h2h.team2Wins > data.h2h.team1Wins * 2) {
        insights.push(`⚔️ ${awayTeam} has historical advantage with ${data.h2h.team2Wins} wins`);
      } else if (data.h2h.draws > data.h2h.totalMatches / 2) {
        insights.push(`⚔️ These teams often draw (${data.h2h.draws} draws in last ${data.h2h.totalMatches})`);
      }
    }
    
    if (data.homeForm.formRating && data.homeForm.formRating === 'Excellent') {
      insights.push(`🔥 ${homeTeam} is in excellent form (${data.homeForm.formString})`);
    }
    if (data.awayForm.formRating && data.awayForm.formRating === 'Excellent') {
      insights.push(`🔥 ${awayTeam} is in excellent form (${data.awayForm.formString})`);
    }
    
    if (data.homeForm.averageGoalsFor && data.homeForm.averageGoalsFor > 2) {
      insights.push(`⚽ ${homeTeam} scores ${data.homeForm.averageGoalsFor} goals per game on average`);
    }
    if (data.awayForm.averageGoalsAgainst && data.awayForm.averageGoalsAgainst > 2) {
      insights.push(`🛡️ ${awayTeam} concedes ${data.awayForm.averageGoalsAgainst} goals per game - defensive weakness`);
    }
    
    if (data.homeWinProb > 65) {
      insights.push(`📊 Strong home advantage predicted for ${homeTeam}`);
    }
    
    return insights;
  }

  // ─── Helper: Identify Key Factors ───────────────────────────────────
  identifyKeyFactors(h2h, homeForm, awayForm) {
    const factors = [];
    
    if (homeForm.formRating === 'Excellent' && awayForm.formRating === 'Poor') {
      factors.push('Major form disparity favors home team');
    }
    if (h2h.advantage && h2h.advantage !== 'Equal') {
      factors.push(`${h2h.advantage} has historical psychological advantage`);
    }
    if (homeForm.averageGoalsFor > 2 && awayForm.averageGoalsAgainst > 2) {
      factors.push('Expected high-scoring match');
    }
    
    return factors;
  }

  // ─── Helper: Calculate Confidence ───────────────────────────────────
  calculateConfidence(home, away, draw) {
    const maxProb = Math.max(home, away, draw);
    if (maxProb > 70) return 'High';
    if (maxProb > 55) return 'Medium';
    return 'Low';
  }
}

// Initialize AI Agent
const aiAgent = new AIAnalysisAgent(FOOTBALL_API_KEY);

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

// ─── Fetch matches from API ───────────────────────────────────────────────
async function fetchAndStoreMatches() {
  try {
    console.log("📡 Fetching matches from football-data.org...");
    
    let matches = [];
    let usedCode = null;
    
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
      console.log("⚠️ No matches found from API");
      return;
    }
    
    console.log(`✅ Successfully fetched ${matches.length} matches from ${usedCode}`);
    
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
           (id, home_team, away_team, start_time, status, home_score, away_score, winner, competition_code, competition_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [match.id, homeTeam, awayTeam, startTime, status, homeScore, awayScore, winner, usedCode, match.competition?.name || 'Unknown']
        );
        stored++;
      } catch (e) {
        // Skip duplicates
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
    bettingOpen: row.status === "SCHEDULED" || row.status === "TIMED" || row.status === "IN_PLAY"
  };
}

// ─── API Endpoints ─────────────────────────────────────────────────────────

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "World Cup 2026 API",
    description: "World Cup matches with AI analysis",
    status: "running",
    environment: isVercel ? "vercel" : "local",
    endpoints: {
      health: "/api/health",
      matches: "/api/matches",
      match: "/api/matches/:id",
      stats: "/api/stats",
      leaderboard: "/api/leaderboard",
      ultimate: "/api/ultimate",
      ai: {
        analyze: "/api/ai/analyze/:matchId",
        head2head: "/api/ai/head2head?team1=&team2=",
        form: "/api/ai/form/:team",
        predict: "/api/ai/predict?home=&away="
      },
      refresh: "/api/refresh",
      debug: "/api/debug"
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

// ─── AI ENDPOINTS ─────────────────────────────────────────────────────

// GET /api/ai/analyze/:matchId - AI analysis for a specific match
app.get("/api/ai/analyze/:matchId", async (req, res) => {
  try {
    const match = await dbGet("SELECT * FROM matches WHERE id=?", [req.params.id]);
    
    if (!match) {
      return res.status(404).json({ error: "Match not found" });
    }
    
    const analysis = await aiAgent.predictOutcome(match.home_team, match.away_team);
    
    res.json({
      matchId: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      analysis,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/head2head - Head-to-head analysis
app.get("/api/ai/head2head", async (req, res) => {
  try {
    const { team1, team2 } = req.query;
    
    if (!team1 || !team2) {
      return res.status(400).json({ error: "Please provide team1 and team2" });
    }
    
    const h2h = await aiAgent.getHeadToHead(team1, team2);
    
    res.json({
      team1,
      team2,
      analysis: h2h,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/form/:team - Team form analysis
app.get("/api/ai/form/:team", async (req, res) => {
  try {
    const form = await aiAgent.getTeamForm(req.params.team);
    res.json(form);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai/predict - Predict match outcome
app.get("/api/ai/predict", async (req, res) => {
  try {
    const { home, away } = req.query;
    
    if (!home || !away) {
      return res.status(400).json({ error: "Please provide home and away teams" });
    }
    
    const prediction = await aiAgent.predictOutcome(home, away);
    
    res.json({
      homeTeam: home,
      awayTeam: away,
      prediction,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/refresh - Manually refresh matches
app.post("/api/refresh", async (req, res) => {
  try {
    await fetchAndStoreMatches();
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    res.json({ 
      success: true, 
      message: "Matches refreshed",
      matchesInDB: count?.c || 0
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// GET /api/debug - Debug endpoint
app.get("/api/debug", async (req, res) => {
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    const sample = await dbGet("SELECT * FROM matches LIMIT 1");
    
    res.json({
      apiKey: FOOTBALL_API_KEY ? "✅" : "❌",
      environment: isVercel ? "vercel" : "local",
      database: {
        matches: count?.c || 0,
        sampleMatch: sample || null
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ─── Initialize on cold start ─────────────────────────────────────────────
async function initialize() {
  console.log("\n🚀 Starting World Cup API...");
  console.log(`📊 Environment: ${isVercel ? 'Vercel' : 'Local'}`);
  console.log(`🔑 API Key: ${FOOTBALL_API_KEY ? '✅' : '❌'}`);
  
  try {
    const count = await dbGet("SELECT COUNT(*) as c FROM matches");
    
    if (!count || count.c === 0) {
      console.log("🔄 No matches found, fetching initial data...");
      await fetchAndStoreMatches();
    } else {
      console.log(`📊 Database already has ${count.c} matches`);
    }
  } catch (error) {
    console.error("Error initializing:", error);
  }
}

// Run initialization
initialize().catch(console.error);

// ─── Export for Vercel ────────────────────────────────────────────────────
module.exports = app;