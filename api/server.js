/**
 * World Cup 2026 Betting — Backend API
 * Fetches matches from football API → caches in Neon DB → serves from DB
 *
 * FIXES vs previous version:
 *  1. FOOTBALL_API_KEY missing no longer crashes — serves DB cache only
 *  2. formatMatch pools are stable per match ID (was Math.random — changed every request)
 *  3. Auto-refresh every 6 hours (was never auto-refreshing)
 *  4. /api/stats returns real live/finished counts from DB (was hardcoded 0)
 *  5. AI predictions cached in DB for 30 min (avoids burning Gemini quota)
 *  6. All AI endpoints have proper try/catch
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const { Pool } = require("pg");
const AIMatchAgent = require("./ai-match-agent.js");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Env ─────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY      = process.env.GEMINI_API_KEY;
const DATABASE_URL        = process.env.DATABASE_URL;
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY;

if (!GEMINI_API_KEY) { console.error("GEMINI_API_KEY missing");  process.exit(1); }
if (!DATABASE_URL)   { console.error("DATABASE_URL missing");     process.exit(1); }
if (!BALLDONTLIE_API_KEY) console.warn("BALLDONTLIE_API_KEY missing — get free key at balldontlie.io");

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.connect((err, client, release) => {
  if (err) console.error("DB connect error:", err.stack);
  else { console.log("Connected to Neon PostgreSQL"); release(); }
});
const query = async (text, params) => {
  try { return await pool.query(text, params); }
  catch (err) { console.error("Query error:", err.message); throw err; }
};

// ─── DB init ──────────────────────────────────────────────────────────────────
async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id               INTEGER   PRIMARY KEY,
      home_team        TEXT      NOT NULL,
      away_team        TEXT      NOT NULL,
      start_time       BIGINT    NOT NULL,
      status           TEXT      DEFAULT 'SCHEDULED',
      home_score       INTEGER   DEFAULT 0,
      away_score       INTEGER   DEFAULT 0,
      winner           TEXT,
      competition_code TEXT,
      competition_name TEXT,
      season           TEXT,
      matchday         INTEGER,
      last_updated     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS cache_metadata (
      key TEXT PRIMARY KEY, last_fetched TIMESTAMP, data_hash TEXT
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS ai_predictions (
      cache_key  TEXT      PRIMARY KEY,
      prediction JSONB     NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_date  ON matches(start_time);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_teams ON matches(home_team, away_team);`);

  const count = parseInt((await query("SELECT COUNT(*) FROM matches")).rows[0].count);
  console.log(`DB ready — ${count} cached matches`);
  return count;
}

// ─── BALLDONTLIE World Cup 2026 API ──────────────────────────────────────────
// Free tier — sign up at https://www.balldontlie.io to get a key
// Has all 104 WC 2026 fixtures NOW, live scores once tournament starts June 11
const BDL_BASE    = "https://api.balldontlie.io/fifa/worldcup/v1";
const BDL_HEADERS = { "Authorization": process.env.BALLDONTLIE_API_KEY || "" };

// BALLDONTLIE uses "scheduled","in_progress","final" — map to our status strings
function normalizeStatus(s) {
  const map = {
    "scheduled"   : "SCHEDULED",
    "in_progress" : "IN_PLAY",
    "final"       : "FINISHED",
    "postponed"   : "POSTPONED",
    "cancelled"   : "CANCELLED",
  };
  return map[s?.toLowerCase()] || "SCHEDULED";
}

async function fetchAndCacheMatches() {
  const bdlKey = process.env.BALLDONTLIE_API_KEY;
  if (!bdlKey) {
    console.log("No BALLDONTLIE_API_KEY — skipping refresh");
    console.log("Get free key at https://www.balldontlie.io");
    return 0;
  }
  console.log("Fetching WC 2026 matches from BALLDONTLIE...");

  let allMatches = [];
  let cursor = null;

  // Paginate through all matches
  do {
    try {
      const url = cursor
        ? `${BDL_BASE}/matches?per_page=50&cursor=${cursor}`
        : `${BDL_BASE}/matches?per_page=50`;
      const resp = await axios.get(url, { headers: BDL_HEADERS, timeout: 10000 });
      const { data, meta } = resp.data;
      allMatches = allMatches.concat(data || []);
      cursor = meta?.next_cursor || null;
    } catch (e) {
      console.error("BALLDONTLIE API error:", e.response?.status, e.message);
      return 0;
    }
  } while (cursor);

  console.log(`${allMatches.length} WC 2026 matches fetched`);
  if (!allMatches.length) return 0;

  // Normalise BALLDONTLIE format → our DB schema
  const matches = allMatches.map(m => ({
    id         : m.id,
    homeTeam   : m.home_team?.name || "TBD",
    awayTeam   : m.away_team?.name || "TBD",
    startTime  : Math.floor(new Date(m.datetime).getTime() / 1000),
    status     : normalizeStatus(m.status),
    homeScore  : m.home_score ?? 0,
    awayScore  : m.away_score ?? 0,
    matchday   : m.match_number || null,
    stage      : m.stage?.name || null,
    group      : m.group?.name || null,
    stadium    : m.stadium?.name || null,
    city       : m.stadium?.city || null,
  }));

  let stored = 0;
  for (const m of matches) {
    // m is already normalised from BALLDONTLIE format above
    const winner = m.status === "FINISHED" && m.homeScore !== m.awayScore
      ? (m.homeScore > m.awayScore ? m.homeTeam : m.awayTeam) : null;

    try {
      await query(
        `INSERT INTO matches
           (id,home_team,away_team,start_time,status,home_score,away_score,
            winner,competition_code,competition_name,season,matchday)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           status=EXCLUDED.status,
           home_score=EXCLUDED.home_score,
           away_score=EXCLUDED.away_score,
           winner=EXCLUDED.winner,
           last_updated=CURRENT_TIMESTAMP`,
        [m.id, m.homeTeam, m.awayTeam, m.startTime, m.status,
         m.homeScore, m.awayScore, winner,
         "WC", "FIFA World Cup 2026", "2026", m.matchday]
      );
      stored++;
    } catch (e) { console.error(`Store match ${m.id}:`, e.message); }
  }

  await query(
    `INSERT INTO cache_metadata (key, last_fetched, data_hash)
     VALUES ('matches', NOW(), $1)
     ON CONFLICT (key) DO UPDATE SET last_fetched=NOW(), data_hash=EXCLUDED.data_hash`,
    [String(stored)]
  );
  console.log(`Stored/updated ${stored} WC matches`);
  return stored;
}

// FIX #3 — auto-refresh every 6 hours (old version never refreshed)
function scheduleAutoRefresh() {
  setInterval(async () => {
    console.log("Auto-refresh...");
    try { await fetchAndCacheMatches(); }
    catch (e) { console.error("Auto-refresh failed:", e.message); }
  }, 6 * 60 * 60 * 1000);
  console.log("Auto-refresh scheduled every 6 hours");
}

// ─── AI Agent ─────────────────────────────────────────────────────────────────
const aiAgent = new AIMatchAgent({ geminiApiKey: GEMINI_API_KEY });
console.log("AI Agent ready (Gemini + Google Search)");

// AI prediction cache helpers
async function getCachedPrediction(key) {
  try {
    const r = await query(
      "SELECT prediction FROM ai_predictions WHERE cache_key=$1 AND expires_at > NOW()",
      [key]
    );
    if (r.rows.length > 0) {
      console.log(`Cache hit: ${key}`);
      return { ...r.rows[0].prediction, _fromCache: true };
    }
  } catch { }
  return null;
}

async function savePrediction(key, prediction) {
  try {
    await query(
      `INSERT INTO ai_predictions (cache_key, prediction, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')
       ON CONFLICT (cache_key) DO UPDATE SET
         prediction=EXCLUDED.prediction,
         created_at=NOW(),
         expires_at=NOW() + INTERVAL '30 minutes'`,
      [key, JSON.stringify(prediction)]
    );
  } catch (e) { console.warn("AI cache write failed:", e.message); }
}

// ─── formatMatch ──────────────────────────────────────────────────────────────
// FIX #2 — pools seeded from match ID so values are stable across requests
function stableRandom(seed, min, max) {
  const x = Math.sin(seed) * 10000;
  return Math.floor((x - Math.floor(x)) * (max - min + 1)) + min;
}

function formatMatch(row) {
  const s        = row.id;
  const homePool = stableRandom(s * 1, 50, 150);
  const drawPool = stableRandom(s * 2, 20,  70);
  const awayPool = stableRandom(s * 3, 40, 120);
  const total    = homePool + drawPool + awayPool;
  return {
    id          : row.id,
    homeTeam    : row.home_team,
    awayTeam    : row.away_team,
    startTime   : row.start_time,
    status      : row.status,
    competition : { code: row.competition_code, name: row.competition_name },
    score       : { home: row.home_score, away: row.away_score },
    winner      : row.winner,
    matchday    : row.matchday,
    pools       : {
      home : homePool.toString(),
      draw : drawPool.toString(),
      away : awayPool.toString(),
      total: total.toString(),
    },
    odds        : {
      home : +((homePool / total) * 100).toFixed(2),
      draw : +((drawPool / total) * 100).toFixed(2),
      away : +((awayPool / total) * 100).toFixed(2),
    },
    bettingOpen : ["SCHEDULED","TIMED","IN_PLAY"].includes(row.status),
  };
}

// ════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.json({
  name     : "World Cup 2026 API",
  endpoints: {
    matches : "GET  /api/matches",
    match   : "GET  /api/matches/:id",
    analyze : "GET  /api/analyze?home=Brazil&away=Argentina",
    gemini  : "GET  /api/ai/gemini/:matchId",
    predict : "GET  /api/ai/predict?home=X&away=Y",
    stats   : "GET  /api/stats",
    refresh : "POST /api/refresh",
    cache   : "GET  /api/cache/info",
    health  : "GET  /api/health",
  },
}));

app.get("/api/health", async (req, res) => {
  try {
    const r = await query("SELECT COUNT(*) FROM matches");
    res.json({ status:"ok", matchesInDB: parseInt(r.rows[0].count), timestamp: new Date().toISOString() });
  } catch { res.json({ status:"ok", matchesInDB: 0 }); }
});

// Matches — served from DB
app.get("/api/matches", async (req, res) => {
  try {
    const { status } = req.query;
    let sql = "SELECT * FROM matches WHERE competition_code = 'WC'";
    const vals = [];
    if (status) { sql += ` AND status=$1`; vals.push(status); }
    sql += " ORDER BY start_time ASC";
    const r = await query(sql, vals);

    // Be honest if WC hasn't started yet
    if (r.rows.length === 0) {
      return res.json({
        matches      : [],
        total        : 0,
        wcStatus     : "not_started",
        message      : "FIFA World Cup 2026 matches not available yet. Tournament starts June 11, 2026.",
        refreshUrl   : "POST /api/refresh to check for new data",
      });
    }

    res.json({ matches: r.rows.map(formatMatch), total: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/matches/:id", async (req, res) => {
  try {
    const r = await query("SELECT * FROM matches WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Match not found" });
    res.json({ match: formatMatch(r.rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FIX #4 — real counts from DB
app.get("/api/stats", async (req, res) => {
  try {
    const [total, live, finished, scheduled] = await Promise.all([
      query("SELECT COUNT(*) FROM matches"),
      query("SELECT COUNT(*) FROM matches WHERE status='IN_PLAY'"),
      query("SELECT COUNT(*) FROM matches WHERE status='FINISHED'"),
      query("SELECT COUNT(*) FROM matches WHERE status IN ('SCHEDULED','TIMED')"),
    ]);
    res.json({
      matchCount       : parseInt(total.rows[0].count),
      liveMatches      : parseInt(live.rows[0].count),
      finishedMatches  : parseInt(finished.rows[0].count),
      scheduledMatches : parseInt(scheduled.rows[0].count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const stored = await fetchAndCacheMatches();
    const total  = parseInt((await query("SELECT COUNT(*) FROM matches")).rows[0].count);
    const cache  = await query("SELECT * FROM cache_metadata WHERE key='matches'");
    res.json({ success: true, stored, totalMatches: total, lastUpdated: cache.rows[0]?.last_fetched });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/cache/info", async (req, res) => {
  try {
    const [cache, count, aiCount] = await Promise.all([
      query("SELECT * FROM cache_metadata WHERE key='matches'"),
      query("SELECT COUNT(*) FROM matches"),
      query("SELECT COUNT(*) FROM ai_predictions WHERE expires_at > NOW()"),
    ]);
    res.json({
      lastFetched       : cache.rows[0]?.last_fetched || null,
      matchesInDB       : parseInt(count.rows[0].count),
      activePredictions : parseInt(aiCount.rows[0].count),
      autoRefresh       : "every 6 hours",
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── AI endpoints ─────────────────────────────────────────────────────────────

app.get("/api/analyze", async (req, res) => {
  const { home, away, competition } = req.query;
  if (!home || !away) return res.status(400).json({ error: "Provide home and away" });
  const key = `predict:${home.toLowerCase()}:${away.toLowerCase()}`;
  try {
    const cached = await getCachedPrediction(key);
    if (cached) return res.json(cached);
    console.log(`Gemini researching: ${home} vs ${away}`);
    const result = await aiAgent.predict(home, away, { competition: competition || "FIFA World Cup 2026" });
    await savePrediction(key, result);
    res.json(result);
  } catch (err) { console.error("/api/analyze error:", err); res.status(500).json({ error: err.message }); }
});

app.get("/api/ai/gemini/:matchId", async (req, res) => {
  try {
    const r = await query("SELECT * FROM matches WHERE id=$1", [req.params.matchId]);
    if (!r.rows.length) return res.status(404).json({ error: "Match not found" });
    const m   = r.rows[0];
    const key = `predict:${m.home_team.toLowerCase()}:${m.away_team.toLowerCase()}`;
    const cached = await getCachedPrediction(key);
    if (cached) return res.json({ matchId: m.id, ...cached });
    console.log(`Gemini: ${m.home_team} vs ${m.away_team}`);
    const result = await aiAgent.predict(m.home_team, m.away_team, { competition: m.competition_name || "FIFA World Cup 2026" });
    await savePrediction(key, result);
    res.json({ matchId: m.id, ...result, timestamp: new Date().toISOString() });
  } catch (err) { console.error("/api/ai/gemini error:", err); res.status(500).json({ error: err.message }); }
});

app.get("/api/ai/predict", async (req, res) => {
  const { home, away, competition } = req.query;
  if (!home || !away) return res.status(400).json({ error: "Provide home and away" });
  const key = `predict:${home.toLowerCase()}:${away.toLowerCase()}`;
  try {
    const cached = await getCachedPrediction(key);
    if (cached) return res.json(cached);
    const result = await aiAgent.predict(home, away, { competition: competition || "FIFA World Cup 2026" });
    await savePrediction(key, result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mock endpoints
app.get("/api/leaderboard", (req, res) => res.json({
  leaderboard: [
    { user: "0x1234...5678", total_wagered: "50000", bet_count: 23 },
    { user: "0x2345...6789", total_wagered: "45000", bet_count: 19 },
    { user: "0x3456...7890", total_wagered: "38000", bet_count: 31 },
  ],
}));

app.get("/api/ultimate", (req, res) => res.json({
  deadline: Math.floor(Date.now()/1000) + 2592000, settled: false, winner: null,
  totalPool: "168000",
  teamPools: [{ team:"Brazil",amount:"45000"},{team:"Argentina",amount:"38000"},{team:"France",amount:"32000"}],
}));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log("=".repeat(55));
  console.log("World Cup 2026 API");
  console.log("=".repeat(55));

  const matchCount = await initDatabase();

  if (matchCount === 0) {
    console.log("Empty DB — fetching from API...");
    await fetchAndCacheMatches();
  } else {
    console.log(`Serving ${matchCount} matches from DB cache`);
  }

  scheduleAutoRefresh();

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server on port ${PORT}`);
    console.log(`Matches  : GET  /api/matches`);
    console.log(`Analyze  : GET  /api/analyze?home=Brazil&away=Argentina`);
    console.log(`Refresh  : POST /api/refresh`);
    console.log("=".repeat(55));
  });
}

start().catch(console.error);
module.exports = app;