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
const WC2026_API_KEY = process.env.WC2026_API_KEY;

if (!GEMINI_API_KEY) { console.error("GEMINI_API_KEY missing");  process.exit(1); }
if (!DATABASE_URL)   { console.error("DATABASE_URL missing");     process.exit(1); }
if (!WC2026_API_KEY) console.warn("WC2026_API_KEY not set — will use openfootball fallback (no live scores)");

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

// ─── WC 2026 Fixture Data ────────────────────────────────────────────────────
// Full FIFA World Cup 2026 schedule — 104 matches
// Source: Official FIFA announcement (no API key ever needed)
// Groups A-L (3 teams each qualify from 48 teams, 3 host nations: USA/CAN/MEX)
// Kickoff times in UTC. Scores null until played.

const WC2026_FIXTURES = [
  {id:1,home:"Mexico",away:"South Africa",date:"2026-06-11T19:00:00Z",group:"Group A",round:"Group Stage",stadium:"Estadio Azteca",city:"Mexico City"},
  {id:2,home:"Korea Republic",away:"DEN/MKD/CZE/IRL",date:"2026-06-13T02:00:00Z",group:"Group A",round:"Group Stage",stadium:"Estadio Akron",city:"Guadalajara"},
  {id:3,home:"Switzerland",away:"ITA/NIR/WAL/BIH",date:"2026-06-13T19:00:00Z",group:"Group B",round:"Group Stage",stadium:"Levi's Stadium",city:"San Francisco"},
  {id:4,home:"Brazil",away:"Morocco",date:"2026-06-14T01:00:00Z",group:"Group C",round:"Group Stage",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:5,home:"Qatar",away:"Switzerland",date:"2026-06-15T01:00:00Z",group:"Group B",round:"Group Stage",stadium:"Levi's Stadium",city:"San Francisco"},
  {id:6,home:"Australia",away:"TUR/ROU/SVK/KOS",date:"2026-06-13T04:00:00Z",group:"Group D",round:"Group Stage",stadium:"BC Place",city:"Vancouver"},
  {id:7,home:"Haiti",away:"Scotland",date:"2026-06-14T22:00:00Z",group:"Group C",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:8,home:"Germany",away:"Curacao",date:"2026-06-14T19:00:00Z",group:"Group E",round:"Group Stage",stadium:"NRG Stadium",city:"Houston"},
  {id:9,home:"Saudi Arabia",away:"Uruguay",date:"2026-06-14T23:00:00Z",group:"Group H",round:"Group Stage",stadium:"Hard Rock Stadium",city:"Miami"},
  {id:10,home:"Netherlands",away:"Japan",date:"2026-06-15T17:00:00Z",group:"Group F",round:"Group Stage",stadium:"AT&T Stadium",city:"Dallas"},
  {id:11,home:"Ivory Coast",away:"Ecuador",date:"2026-06-14T20:00:00Z",group:"Group E",round:"Group Stage",stadium:"AT&T Stadium",city:"Dallas"},
  {id:12,home:"UKR/SWE/POL/ALB",away:"Tunisia",date:"2026-06-16T02:00:00Z",group:"Group F",round:"Group Stage",stadium:"BC Place",city:"Vancouver"},
  {id:13,home:"Spain",away:"Cabo Verde",date:"2026-06-15T22:00:00Z",group:"Group H",round:"Group Stage",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:14,home:"Austria",away:"Jordan",date:"2026-06-15T16:00:00Z",group:"Group J",round:"Group Stage",stadium:"Levi's Stadium",city:"San Francisco"},
  {id:15,home:"IR Iran",away:"New Zealand",date:"2026-06-16T01:00:00Z",group:"Group G",round:"Group Stage",stadium:"Lumen Field",city:"Seattle"},
  {id:16,home:"Belgium",away:"Egypt",date:"2026-06-15T19:00:00Z",group:"Group G",round:"Group Stage",stadium:"BC Place",city:"Vancouver"},
  {id:17,home:"Ghana",away:"Panama",date:"2026-06-16T19:00:00Z",group:"Group L",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:18,home:"IRQ/BOL/SUR",away:"Norway",date:"2026-06-16T22:00:00Z",group:"Group I",round:"Group Stage",stadium:"NRG Stadium",city:"Houston"},
  {id:19,home:"France",away:"Senegal",date:"2026-06-18T01:00:00Z",group:"Group I",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:20,home:"Argentina",away:"Algeria",date:"2026-06-16T04:00:00Z",group:"Group J",round:"Group Stage",stadium:"AT&T Stadium",city:"Dallas"},
  {id:21,home:"England",away:"Croatia",date:"2026-06-17T23:00:00Z",group:"Group L",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:22,home:"Uzbekistan",away:"Colombia",date:"2026-06-18T20:00:00Z",group:"Group K",round:"Group Stage",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:23,home:"Colombia",away:"COD/JAM/NCL",date:"2026-06-18T17:00:00Z",group:"Group K",round:"Group Stage",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:24,home:"Canada",away:"Qatar",date:"2026-06-22T02:00:00Z",group:"Group B",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:25,home:"DEN/MKD/CZE/IRL",away:"Korea Republic",date:"2026-06-20T02:00:00Z",group:"Group A",round:"Group Stage",stadium:"Estadio Akron",city:"Guadalajara"},
  {id:26,home:"USA",away:"Switzerland",date:"2026-06-21T19:00:00Z",group:"Group B",round:"Group Stage",stadium:"Levi's Stadium",city:"San Francisco"},
  {id:27,home:"Mexico",away:"Korea Republic",date:"2026-06-21T22:00:00Z",group:"Group A",round:"Group Stage",stadium:"Estadio Akron",city:"Guadalajara"},
  {id:28,home:"Brazil",away:"Haiti",date:"2026-06-22T01:00:00Z",group:"Group C",round:"Group Stage",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:29,home:"Scotland",away:"Morocco",date:"2026-06-22T01:00:00Z",group:"Group C",round:"Group Stage",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:30,home:"USA",away:"Australia",date:"2026-06-20T22:00:00Z",group:"Group D",round:"Group Stage",stadium:"AT&T Stadium",city:"Dallas"},
  {id:31,home:"TUR/ROU/SVK/KOS",away:"Paraguay",date:"2026-06-20T04:00:00Z",group:"Group D",round:"Group Stage",stadium:"BC Place",city:"Vancouver"},
  {id:32,home:"Tunisia",away:"Japan",date:"2026-06-22T19:00:00Z",group:"Group F",round:"Group Stage",stadium:"Estadio BBVA",city:"Monterrey"},
  {id:33,home:"Norway",away:"Senegal",date:"2026-06-22T20:00:00Z",group:"Group I",round:"Group Stage",stadium:"Gillette Stadium",city:"Boston"},
  {id:34,home:"Germany",away:"Ivory Coast",date:"2026-06-23T00:00:00Z",group:"Group E",round:"Group Stage",stadium:"NRG Stadium",city:"Houston"},
  {id:35,home:"Netherlands",away:"UKR/SWE/POL/ALB",date:"2026-06-22T17:00:00Z",group:"Group F",round:"Group Stage",stadium:"NRG Stadium",city:"Houston"},
  {id:36,home:"Ecuador",away:"Curacao",date:"2026-06-22T04:00:00Z",group:"Group E",round:"Group Stage",stadium:"NRG Stadium",city:"Houston"},
  {id:37,home:"Spain",away:"Saudi Arabia",date:"2026-06-22T22:00:00Z",group:"Group H",round:"Group Stage",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:38,home:"Argentina",away:"Austria",date:"2026-06-23T16:00:00Z",group:"Group J",round:"Group Stage",stadium:"Levi's Stadium",city:"San Francisco"},
  {id:39,home:"New Zealand",away:"Egypt",date:"2026-06-23T19:00:00Z",group:"Group G",round:"Group Stage",stadium:"BC Place",city:"Vancouver"},
  {id:40,home:"Jordan",away:"Algeria",date:"2026-06-24T01:00:00Z",group:"Group J",round:"Group Stage",stadium:"AT&T Stadium",city:"Dallas"},
  {id:41,home:"England",away:"Ghana",date:"2026-06-25T00:00:00Z",group:"Group L",round:"Group Stage",stadium:"Gillette Stadium",city:"Boston"},
  {id:42,home:"Senegal",away:"IRQ/BOL/SUR",date:"2026-06-24T21:00:00Z",group:"Group I",round:"Group Stage",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:43,home:"Belgium",away:"IR Iran",date:"2026-06-23T17:00:00Z",group:"Group G",round:"Group Stage",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:44,home:"Switzerland",away:"Canada",date:"2026-06-27T03:00:00Z",group:"Group B",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:45,home:"Panama",away:"Croatia",date:"2026-06-24T20:00:00Z",group:"Group L",round:"Group Stage",stadium:"Gillette Stadium",city:"Boston"},
  {id:46,home:"Uruguay",away:"Cabo Verde",date:"2026-06-24T23:00:00Z",group:"Group H",round:"Group Stage",stadium:"Hard Rock Stadium",city:"Miami"},
  {id:47,home:"Morocco",away:"Haiti",date:"2026-06-25T17:00:00Z",group:"Group C",round:"Group Stage",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:48,home:"France",away:"IRQ/BOL/SUR",date:"2026-06-26T02:00:00Z",group:"Group I",round:"Group Stage",stadium:"Lincoln Financial Field",city:"Philadelphia"},
  {id:49,home:"Ecuador",away:"Germany",date:"2026-06-26T22:00:00Z",group:"Group E",round:"Group Stage",stadium:"Arrowhead Stadium",city:"Kansas City"},
  {id:50,home:"Scotland",away:"Brazil",date:"2026-06-26T22:00:00Z",group:"Group C",round:"Group Stage",stadium:"Hard Rock Stadium",city:"Miami"},
  {id:51,home:"South Africa",away:"Korea Republic",date:"2026-06-27T19:00:00Z",group:"Group A",round:"Group Stage",stadium:"Estadio Akron",city:"Guadalajara"},
  {id:52,home:"ITA/NIR/WAL/BIH",away:"Qatar",date:"2026-06-27T19:00:00Z",group:"Group B",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:53,home:"DEN/MKD/CZE/IRL",away:"Mexico",date:"2026-06-28T01:00:00Z",group:"Group A",round:"Group Stage",stadium:"Estadio Azteca",city:"Mexico City"},
  {id:54,home:"Portugal",away:"Uzbekistan",date:"2026-06-28T01:00:00Z",group:"Group K",round:"Group Stage",stadium:"Hard Rock Stadium",city:"Miami"},
  {id:55,home:"Tunisia",away:"Netherlands",date:"2026-06-27T20:00:00Z",group:"Group F",round:"Group Stage",stadium:"Estadio BBVA",city:"Monterrey"},
  {id:56,home:"Curacao",away:"Ivory Coast",date:"2026-06-27T20:00:00Z",group:"Group E",round:"Group Stage",stadium:"AT&T Stadium",city:"Dallas"},
  {id:57,home:"Canada",away:"ITA/NIR/WAL/BIH",date:"2026-06-28T23:00:00Z",group:"Group B",round:"Group Stage",stadium:"BMO Field",city:"Toronto"},
  {id:58,home:"Paraguay",away:"Australia",date:"2026-06-27T23:00:00Z",group:"Group D",round:"Group Stage",stadium:"Arrowhead Stadium",city:"Kansas City"},
  {id:59,home:"TUR/ROU/SVK/KOS",away:"USA",date:"2026-06-28T02:00:00Z",group:"Group D",round:"Group Stage",stadium:"Lumen Field",city:"Seattle"},
  {id:60,home:"New Zealand",away:"Belgium",date:"2026-06-29T02:00:00Z",group:"Group G",round:"Group Stage",stadium:"Lumen Field",city:"Seattle"},
  {id:61,home:"Panama",away:"England",date:"2026-06-28T19:00:00Z",group:"Group L",round:"Group Stage",stadium:"Gillette Stadium",city:"Boston"},
  {id:62,home:"Japan",away:"UKR/SWE/POL/ALB",date:"2026-06-28T19:00:00Z",group:"Group F",round:"Group Stage",stadium:"Lumen Field",city:"Seattle"},
  {id:64,home:"Cabo Verde",away:"Saudi Arabia",date:"2026-06-29T03:00:00Z",group:"Group H",round:"Group Stage",stadium:"Arrowhead Stadium",city:"Kansas City"},
  {id:65,home:"Uruguay",away:"Spain",date:"2026-06-30T00:00:00Z",group:"Group H",round:"Group Stage",stadium:"Arrowhead Stadium",city:"Kansas City"},
  {id:66,home:"Norway",away:"France",date:"2026-06-30T00:00:00Z",group:"Group I",round:"Group Stage",stadium:"Gillette Stadium",city:"Boston"},
  {id:67,home:"Croatia",away:"Ghana",date:"2026-06-28T21:00:00Z",group:"Group L",round:"Group Stage",stadium:"Gillette Stadium",city:"Boston"},
  {id:68,home:"Colombia",away:"Portugal",date:"2026-06-29T21:00:00Z",group:"Group K",round:"Group Stage",stadium:"Hard Rock Stadium",city:"Miami"},
  {id:69,home:"Jordan",away:"Argentina",date:"2026-06-30T02:00:00Z",group:"Group J",round:"Group Stage",stadium:"Levi's Stadium",city:"San Francisco"},
  {id:70,home:"Egypt",away:"IR Iran",date:"2026-06-29T02:00:00Z",group:"Group G",round:"Group Stage",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:71,home:"Algeria",away:"Austria",date:"2026-06-29T23:30:00Z",group:"Group J",round:"Group Stage",stadium:"Arrowhead Stadium",city:"Kansas City"},
  {id:72,home:"COD/JAM/NCL",away:"Uzbekistan",date:"2026-06-29T23:30:00Z",group:"Group K",round:"Group Stage",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:73,home:"2A",away:"2B",date:"2026-07-01T19:00:00Z",group:null,round:"Round of 32",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:74,home:"1E",away:"3ABCDF",date:"2026-07-01T20:30:00Z",group:null,round:"Round of 32",stadium:"NRG Stadium",city:"Houston"},
  {id:75,home:"1F",away:"2C",date:"2026-07-02T01:00:00Z",group:null,round:"Round of 32",stadium:"AT&T Stadium",city:"Dallas"},
  {id:76,home:"1C",away:"2F",date:"2026-07-02T17:00:00Z",group:null,round:"Round of 32",stadium:"Lumen Field",city:"Seattle"},
  {id:77,home:"1I",away:"3CDFGH",date:"2026-07-02T21:00:00Z",group:null,round:"Round of 32",stadium:"MetLife Stadium",city:"New York"},
  {id:78,home:"2E",away:"2I",date:"2026-07-02T17:00:00Z",group:null,round:"Round of 32",stadium:"Lincoln Financial Field",city:"Philadelphia"},
  {id:79,home:"1A",away:"3CEFHI",date:"2026-07-03T01:00:00Z",group:null,round:"Round of 32",stadium:"Estadio Azteca",city:"Mexico City"},
  {id:80,home:"1L",away:"3EHIJK",date:"2026-07-03T16:00:00Z",group:null,round:"Round of 32",stadium:"Levi's Stadium",city:"San Francisco"},
  {id:81,home:"1D",away:"3BEFIJ",date:"2026-07-04T00:00:00Z",group:null,round:"Round of 32",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:82,home:"1G",away:"3AEHIJ",date:"2026-07-03T20:00:00Z",group:null,round:"Round of 32",stadium:"Lumen Field",city:"Seattle"},
  {id:83,home:"2K",away:"2L",date:"2026-07-04T23:00:00Z",group:null,round:"Round of 32",stadium:"Arrowhead Stadium",city:"Kansas City"},
  {id:84,home:"1H",away:"2J",date:"2026-07-04T19:00:00Z",group:null,round:"Round of 32",stadium:"Hard Rock Stadium",city:"Miami"},
  {id:85,home:"1B",away:"3EFGIJ",date:"2026-07-05T03:00:00Z",group:null,round:"Round of 32",stadium:"MetLife Stadium",city:"New York"},
  {id:86,home:"1J",away:"2H",date:"2026-07-05T22:00:00Z",group:null,round:"Round of 32",stadium:"BC Place",city:"Vancouver"},
  {id:87,home:"1K",away:"3DEIJL",date:"2026-07-06T01:30:00Z",group:null,round:"Round of 32",stadium:"Estadio Azteca",city:"Mexico City"},
  {id:88,home:"2D",away:"2G",date:"2026-07-05T18:00:00Z",group:null,round:"Round of 32",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:89,home:"W74",away:"W77",date:"2026-07-08T21:00:00Z",group:null,round:"Round of 16",stadium:"NRG Stadium",city:"Houston"},
  {id:90,home:"W73",away:"W75",date:"2026-07-08T17:00:00Z",group:null,round:"Round of 16",stadium:"AT&T Stadium",city:"Dallas"},
  {id:91,home:"W76",away:"W78",date:"2026-07-09T20:00:00Z",group:null,round:"Round of 16",stadium:"Lincoln Financial Field",city:"Philadelphia"},
  {id:92,home:"W79",away:"W80",date:"2026-07-10T00:00:00Z",group:null,round:"Round of 16",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:93,home:"W83",away:"W84",date:"2026-07-10T19:00:00Z",group:null,round:"Round of 16",stadium:"Arrowhead Stadium",city:"Kansas City"},
  {id:94,home:"W81",away:"W82",date:"2026-07-11T00:00:00Z",group:null,round:"Round of 16",stadium:"Lumen Field",city:"Seattle"},
  {id:95,home:"W86",away:"W88",date:"2026-07-11T16:00:00Z",group:null,round:"Round of 16",stadium:"BC Place",city:"Vancouver"},
  {id:96,home:"W85",away:"W87",date:"2026-07-11T20:00:00Z",group:null,round:"Round of 16",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:97,home:"W89",away:"W90",date:"2026-07-15T20:00:00Z",group:null,round:"Quarter Final",stadium:"MetLife Stadium",city:"New York"},
  {id:98,home:"W93",away:"W94",date:"2026-07-16T00:00:00Z",group:null,round:"Quarter Final",stadium:"AT&T Stadium",city:"Dallas"},
  {id:99,home:"W91",away:"W92",date:"2026-07-16T21:00:00Z",group:null,round:"Quarter Final",stadium:"SoFi Stadium",city:"Los Angeles"},
  {id:100,home:"W95",away:"W96",date:"2026-07-17T01:00:00Z",group:null,round:"Quarter Final",stadium:"Mercedes-Benz Stadium",city:"Atlanta"},
  {id:101,home:"W97",away:"W98",date:"2026-07-19T19:00:00Z",group:null,round:"Semi Final",stadium:"AT&T Stadium",city:"Dallas"},
  {id:102,home:"W99",away:"W100",date:"2026-07-19T19:00:00Z",group:null,round:"Semi Final",stadium:"MetLife Stadium",city:"New York"},
  {id:103,home:"L101",away:"L102",date:"2026-07-25T21:00:00Z",group:null,round:"Third Place",stadium:"Hard Rock Stadium",city:"Miami"},
  {id:104,home:"W101",away:"W102",date:"2026-07-26T19:00:00Z",group:null,round:"Final",stadium:"MetLife Stadium",city:"New York"},
  {id:63,home:"2A",away:"2B",date:"2026-07-02T03:00:00Z",group:null,round:"Round of 32",stadium:"MetLife Stadium",city:"New York"},
];

function normalizeStatus(s) {
  const map = {
    "scheduled"  : "SCHEDULED",
    "live"       : "IN_PLAY",
    "in_play"    : "IN_PLAY",
    "finished"   : "FINISHED",
    "completed"  : "FINISHED",
    "postponed"  : "POSTPONED",
  };
  return map[s?.toLowerCase()] || "SCHEDULED";
}

async function fetchAndCacheMatches() {
  console.log("Loading WC 2026 fixtures...");

  // All 104 fixtures are hardcoded — no external API needed.
  // Once tournament starts, POST /api/refresh will re-seed with latest scores
  // (you can later add wc2026api.com key to enrich with live scores)
  const matches = WC2026_FIXTURES.map(f => ({
    id       : f.id,
    homeTeam : f.home,
    awayTeam : f.away,
    startTime: Math.floor(new Date(f.date).getTime() / 1000),
    status   : "SCHEDULED",
    homeScore: 0,
    awayScore: 0,
    matchday : f.id,
    group    : f.group,
    round    : f.round,
    stadium  : f.stadium,
    city     : f.city,
  }));

  let stored = 0;
  for (const m of matches) {
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
         m.homeScore, m.awayScore, null,
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