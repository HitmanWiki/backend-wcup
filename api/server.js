/**
 * World Cup 2026 Betting — Backend API
 * Complete World Cup 2026 fixture list (104 matches)
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const { Pool } = require("pg");
const AIMatchAgent = require("./ai-match-agent.js");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Env ─────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY      = process.env.GEMINI_API_KEY;
const DATABASE_URL        = process.env.DATABASE_URL;
const FOOTBALL_DATA_KEY   = process.env.FOOTBALL_DATA_API_KEY;
const API_FOOTBALL_KEY    = process.env.API_FOOTBALL_KEY;
const ADMIN_PRIVATE_KEY   = process.env.ADMIN_PRIVATE_KEY || '';
const TOKEN_ADDRESS       = process.env.TOKEN_ADDRESS || '';
const BETTING_ADDRESS     = process.env.BETTING_ADDRESS || '';
const RPC_URL             = process.env.RPC_URL || 'https://mainnet.base.org';

if (!GEMINI_API_KEY) { console.error("GEMINI_API_KEY missing");  process.exit(1); }
if (!DATABASE_URL)   { console.error("DATABASE_URL missing");     process.exit(1); }

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({ 
  connectionString: DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

pool.connect((err, client, release) => {
  if (err) console.error("DB connect error:", err.stack);
  else { console.log("✅ Connected to Neon PostgreSQL"); release(); }
});

const query = async (text, params) => {
  try { return await pool.query(text, params); }
  catch (err) { console.error("Query error:", err.message); throw err; }
};

// ─── Admin Wallet & Contract ─────────────────────────────────────────────────
let adminWallet = null;
let bettingContract = null;

function initAdmin() {
  if (!ADMIN_PRIVATE_KEY || !BETTING_ADDRESS) {
    console.log("⚠️ Admin not configured - contract automation disabled");
    return false;
  }
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    adminWallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    bettingContract = new ethers.Contract(BETTING_ADDRESS, [
      "function createMatch(string,string,uint256,uint256) returns (uint256)",
      "function settleMatch(uint256,uint8)",
      "function settleUltimate(string)",
      "function matchCount() view returns (uint256)",
      "function getMatch(uint256) view returns (tuple(string,string,uint256,uint256,uint8,bool,uint256,uint256,uint256,uint256))",
      "function ultimateSettled() view returns (bool)"
    ], adminWallet);
    console.log(`✅ Admin wallet: ${adminWallet.address}`);
    return true;
  } catch (e) {
    console.error("❌ Admin init failed:", e.message);
    return false;
  }
}

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
      group_name       TEXT,
      round            TEXT,
      stadium          TEXT,
      city             TEXT,
      season           TEXT,
      matchday         INTEGER,
      last_updated     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  await query(`
    CREATE TABLE IF NOT EXISTS bets (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id),
      user_address TEXT NOT NULL,
      prediction TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT,
      claimed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ultimate_bets (
      id SERIAL PRIMARY KEY,
      user_address TEXT NOT NULL,
      team TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT,
      claimed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS betting_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      ultimate_deadline BIGINT NOT NULL DEFAULT 0,
      ultimate_settled BOOLEAN DEFAULT FALSE,
      ultimate_winner TEXT
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

  await query(`CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(start_time);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_matches_teams ON matches(home_team, away_team);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_address);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(match_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ultimate_bets_user ON ultimate_bets(user_address);`);

  // Seed ultimate deadline: July 20, 2026 00:30 UTC
  await query(`
    INSERT INTO betting_settings (id, ultimate_deadline) 
    VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET ultimate_deadline = EXCLUDED.ultimate_deadline
  `, [1784577000]);

  const count = parseInt((await query("SELECT COUNT(*) FROM matches")).rows[0].count || "0");
  console.log(`✅ DB ready — ${count} cached matches`);
  return count;
}

// ─── Official FIFA World Cup 2026 Fixtures (104 matches) ──────────────────────
const WC2026_FIXTURES = [
  // ═══════════════════════════════════════════════════════
  // GROUP STAGE - 72 Matches
  // ═══════════════════════════════════════════════════════
  
  // Group A
  {id:1, home:"Mexico", away:"South Africa", date:"2026-06-12T00:30:00Z", group:"A", round:"Group Stage", stadium:"Mexico City Stadium", city:"Mexico City"},
  {id:2, home:"Korea Republic", away:"Czechia", date:"2026-06-12T07:30:00Z", group:"A", round:"Group Stage", stadium:"Guadalajara Stadium", city:"Guadalajara"},
  {id:3, home:"Czechia", away:"South Africa", date:"2026-06-18T21:30:00Z", group:"A", round:"Group Stage", stadium:"Atlanta Stadium", city:"Atlanta"},
  {id:4, home:"Mexico", away:"Korea Republic", date:"2026-06-19T06:30:00Z", group:"A", round:"Group Stage", stadium:"Guadalajara Stadium", city:"Guadalajara"},
  {id:5, home:"Czechia", away:"Mexico", date:"2026-06-25T06:30:00Z", group:"A", round:"Group Stage", stadium:"Mexico City Stadium", city:"Mexico City"},
  {id:6, home:"South Africa", away:"Korea Republic", date:"2026-06-25T06:30:00Z", group:"A", round:"Group Stage", stadium:"Monterrey Stadium", city:"Monterrey"},
  
  // Group B
  {id:7, home:"Canada", away:"Bosnia and Herzegovina", date:"2026-06-13T00:30:00Z", group:"B", round:"Group Stage", stadium:"Toronto Stadium", city:"Toronto"},
  {id:8, home:"Qatar", away:"Switzerland", date:"2026-06-14T00:30:00Z", group:"B", round:"Group Stage", stadium:"San Francisco Bay Area Stadium", city:"San Francisco Bay Area"},
  {id:9, home:"Switzerland", away:"Bosnia and Herzegovina", date:"2026-06-19T00:30:00Z", group:"B", round:"Group Stage", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:10, home:"Canada", away:"Qatar", date:"2026-06-19T03:30:00Z", group:"B", round:"Group Stage", stadium:"BC Place Vancouver", city:"Vancouver"},
  {id:11, home:"Switzerland", away:"Canada", date:"2026-06-25T00:30:00Z", group:"B", round:"Group Stage", stadium:"BC Place Vancouver", city:"Vancouver"},
  {id:12, home:"Bosnia and Herzegovina", away:"Qatar", date:"2026-06-25T00:30:00Z", group:"B", round:"Group Stage", stadium:"Seattle Stadium", city:"Seattle"},
  
  // Group C
  {id:13, home:"Brazil", away:"Morocco", date:"2026-06-14T03:30:00Z", group:"C", round:"Group Stage", stadium:"New York/New Jersey Stadium", city:"New York"},
  {id:14, home:"Haiti", away:"Scotland", date:"2026-06-14T06:30:00Z", group:"C", round:"Group Stage", stadium:"Boston Stadium", city:"Boston"},
  {id:15, home:"Scotland", away:"Morocco", date:"2026-06-20T03:30:00Z", group:"C", round:"Group Stage", stadium:"Boston Stadium", city:"Boston"},
  {id:16, home:"Brazil", away:"Haiti", date:"2026-06-20T06:00:00Z", group:"C", round:"Group Stage", stadium:"Philadelphia Stadium", city:"Philadelphia"},
  {id:17, home:"Scotland", away:"Brazil", date:"2026-06-25T03:30:00Z", group:"C", round:"Group Stage", stadium:"Miami Stadium", city:"Miami"},
  {id:18, home:"Morocco", away:"Haiti", date:"2026-06-25T03:30:00Z", group:"C", round:"Group Stage", stadium:"Atlanta Stadium", city:"Atlanta"},
  
  // Group D
  {id:19, home:"USA", away:"Paraguay", date:"2026-06-13T06:30:00Z", group:"D", round:"Group Stage", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:20, home:"Australia", away:"Türkiye", date:"2026-06-14T09:30:00Z", group:"D", round:"Group Stage", stadium:"BC Place Vancouver", city:"Vancouver"},
  {id:21, home:"USA", away:"Australia", date:"2026-06-20T00:30:00Z", group:"D", round:"Group Stage", stadium:"Seattle Stadium", city:"Seattle"},
  {id:22, home:"Türkiye", away:"Paraguay", date:"2026-06-20T08:30:00Z", group:"D", round:"Group Stage", stadium:"San Francisco Bay Area Stadium", city:"San Francisco Bay Area"},
  {id:23, home:"Türkiye", away:"USA", date:"2026-06-26T07:30:00Z", group:"D", round:"Group Stage", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:24, home:"Paraguay", away:"Australia", date:"2026-06-26T07:30:00Z", group:"D", round:"Group Stage", stadium:"San Francisco Bay Area Stadium", city:"San Francisco Bay Area"},
  
  // Group E
  {id:25, home:"Germany", away:"Curaçao", date:"2026-06-14T22:30:00Z", group:"E", round:"Group Stage", stadium:"Houston Stadium", city:"Houston"},
  {id:26, home:"Côte d'Ivoire", away:"Ecuador", date:"2026-06-15T04:30:00Z", group:"E", round:"Group Stage", stadium:"Philadelphia Stadium", city:"Philadelphia"},
  {id:27, home:"Germany", away:"Côte d'Ivoire", date:"2026-06-21T01:30:00Z", group:"E", round:"Group Stage", stadium:"Toronto Stadium", city:"Toronto"},
  {id:28, home:"Ecuador", away:"Curaçao", date:"2026-06-21T05:30:00Z", group:"E", round:"Group Stage", stadium:"Kansas City Stadium", city:"Kansas City"},
  {id:29, home:"Curaçao", away:"Côte d'Ivoire", date:"2026-06-26T01:30:00Z", group:"E", round:"Group Stage", stadium:"Philadelphia Stadium", city:"Philadelphia"},
  {id:30, home:"Ecuador", away:"Germany", date:"2026-06-26T01:30:00Z", group:"E", round:"Group Stage", stadium:"New York/New Jersey Stadium", city:"New York"},
  
  // Group F
  {id:31, home:"Netherlands", away:"Japan", date:"2026-06-15T01:30:00Z", group:"F", round:"Group Stage", stadium:"Dallas Stadium", city:"Dallas"},
  {id:32, home:"Sweden", away:"Tunisia", date:"2026-06-15T07:30:00Z", group:"F", round:"Group Stage", stadium:"Monterrey Stadium", city:"Monterrey"},
  {id:33, home:"Netherlands", away:"Sweden", date:"2026-06-20T22:30:00Z", group:"F", round:"Group Stage", stadium:"Houston Stadium", city:"Houston"},
  {id:34, home:"Tunisia", away:"Japan", date:"2026-06-21T09:30:00Z", group:"F", round:"Group Stage", stadium:"Monterrey Stadium", city:"Monterrey"},
  {id:35, home:"Japan", away:"Sweden", date:"2026-06-26T04:30:00Z", group:"F", round:"Group Stage", stadium:"Dallas Stadium", city:"Dallas"},
  {id:36, home:"Tunisia", away:"Netherlands", date:"2026-06-26T04:30:00Z", group:"F", round:"Group Stage", stadium:"Kansas City Stadium", city:"Kansas City"},
  
  // Group G
  {id:37, home:"Belgium", away:"Egypt", date:"2026-06-16T00:30:00Z", group:"G", round:"Group Stage", stadium:"Seattle Stadium", city:"Seattle"},
  {id:38, home:"IR Iran", away:"New Zealand", date:"2026-06-16T06:30:00Z", group:"G", round:"Group Stage", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:39, home:"Belgium", away:"IR Iran", date:"2026-06-22T00:30:00Z", group:"G", round:"Group Stage", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:40, home:"New Zealand", away:"Egypt", date:"2026-06-22T06:30:00Z", group:"G", round:"Group Stage", stadium:"BC Place Vancouver", city:"Vancouver"},
  {id:41, home:"Egypt", away:"IR Iran", date:"2026-06-27T08:30:00Z", group:"G", round:"Group Stage", stadium:"Seattle Stadium", city:"Seattle"},
  {id:42, home:"New Zealand", away:"Belgium", date:"2026-06-27T08:30:00Z", group:"G", round:"Group Stage", stadium:"BC Place Vancouver", city:"Vancouver"},
  
  // Group H
  {id:43, home:"Spain", away:"Cabo Verde", date:"2026-06-15T21:30:00Z", group:"H", round:"Group Stage", stadium:"Atlanta Stadium", city:"Atlanta"},
  {id:44, home:"Saudi Arabia", away:"Uruguay", date:"2026-06-16T03:30:00Z", group:"H", round:"Group Stage", stadium:"Miami Stadium", city:"Miami"},
  {id:45, home:"Spain", away:"Saudi Arabia", date:"2026-06-21T21:30:00Z", group:"H", round:"Group Stage", stadium:"Atlanta Stadium", city:"Atlanta"},
  {id:46, home:"Uruguay", away:"Cabo Verde", date:"2026-06-22T03:30:00Z", group:"H", round:"Group Stage", stadium:"Miami Stadium", city:"Miami"},
  {id:47, home:"Cabo Verde", away:"Saudi Arabia", date:"2026-06-27T05:30:00Z", group:"H", round:"Group Stage", stadium:"Houston Stadium", city:"Houston"},
  {id:48, home:"Uruguay", away:"Spain", date:"2026-06-27T05:30:00Z", group:"H", round:"Group Stage", stadium:"Guadalajara Stadium", city:"Guadalajara"},
  
  // Group I
  {id:49, home:"France", away:"Senegal", date:"2026-06-17T00:30:00Z", group:"I", round:"Group Stage", stadium:"New York/New Jersey Stadium", city:"New York"},
  {id:50, home:"Iraq", away:"Norway", date:"2026-06-17T03:30:00Z", group:"I", round:"Group Stage", stadium:"Boston Stadium", city:"Boston"},
  {id:51, home:"France", away:"Iraq", date:"2026-06-23T02:30:00Z", group:"I", round:"Group Stage", stadium:"Philadelphia Stadium", city:"Philadelphia"},
  {id:52, home:"Norway", away:"Senegal", date:"2026-06-23T05:30:00Z", group:"I", round:"Group Stage", stadium:"New York/New Jersey Stadium", city:"New York"},
  {id:53, home:"Norway", away:"France", date:"2026-06-27T00:30:00Z", group:"I", round:"Group Stage", stadium:"Boston Stadium", city:"Boston"},
  {id:54, home:"Senegal", away:"Iraq", date:"2026-06-27T00:30:00Z", group:"I", round:"Group Stage", stadium:"Toronto Stadium", city:"Toronto"},
  
  // Group J
  {id:55, home:"Argentina", away:"Algeria", date:"2026-06-17T06:30:00Z", group:"J", round:"Group Stage", stadium:"Kansas City Stadium", city:"Kansas City"},
  {id:56, home:"Austria", away:"Jordan", date:"2026-06-17T09:30:00Z", group:"J", round:"Group Stage", stadium:"San Francisco Bay Area Stadium", city:"San Francisco Bay Area"},
  {id:57, home:"Argentina", away:"Austria", date:"2026-06-22T22:30:00Z", group:"J", round:"Group Stage", stadium:"Dallas Stadium", city:"Dallas"},
  {id:58, home:"Jordan", away:"Algeria", date:"2026-06-23T08:30:00Z", group:"J", round:"Group Stage", stadium:"San Francisco Bay Area Stadium", city:"San Francisco Bay Area"},
  {id:59, home:"Algeria", away:"Austria", date:"2026-06-28T07:30:00Z", group:"J", round:"Group Stage", stadium:"Kansas City Stadium", city:"Kansas City"},
  {id:60, home:"Jordan", away:"Argentina", date:"2026-06-28T07:30:00Z", group:"J", round:"Group Stage", stadium:"Dallas Stadium", city:"Dallas"},
  
  // Group K
  {id:61, home:"Portugal", away:"Congo DR", date:"2026-06-17T22:30:00Z", group:"K", round:"Group Stage", stadium:"Houston Stadium", city:"Houston"},
  {id:62, home:"Uzbekistan", away:"Colombia", date:"2026-06-18T07:30:00Z", group:"K", round:"Group Stage", stadium:"Mexico City Stadium", city:"Mexico City"},
  {id:63, home:"Portugal", away:"Uzbekistan", date:"2026-06-23T22:30:00Z", group:"K", round:"Group Stage", stadium:"Houston Stadium", city:"Houston"},
  {id:64, home:"Colombia", away:"Congo DR", date:"2026-06-24T07:30:00Z", group:"K", round:"Group Stage", stadium:"Guadalajara Stadium", city:"Guadalajara"},
  {id:65, home:"Colombia", away:"Portugal", date:"2026-06-28T05:00:00Z", group:"K", round:"Group Stage", stadium:"Miami Stadium", city:"Miami"},
  {id:66, home:"Congo DR", away:"Uzbekistan", date:"2026-06-28T05:00:00Z", group:"K", round:"Group Stage", stadium:"Atlanta Stadium", city:"Atlanta"},
  
  // Group L
  {id:67, home:"England", away:"Croatia", date:"2026-06-18T01:30:00Z", group:"L", round:"Group Stage", stadium:"Dallas Stadium", city:"Dallas"},
  {id:68, home:"Ghana", away:"Panama", date:"2026-06-18T04:30:00Z", group:"L", round:"Group Stage", stadium:"Toronto Stadium", city:"Toronto"},
  {id:69, home:"England", away:"Ghana", date:"2026-06-24T01:30:00Z", group:"L", round:"Group Stage", stadium:"Boston Stadium", city:"Boston"},
  {id:70, home:"Panama", away:"Croatia", date:"2026-06-24T04:30:00Z", group:"L", round:"Group Stage", stadium:"Toronto Stadium", city:"Toronto"},
  {id:71, home:"Panama", away:"England", date:"2026-06-28T02:30:00Z", group:"L", round:"Group Stage", stadium:"New York/New Jersey Stadium", city:"New York"},
  {id:72, home:"Croatia", away:"Ghana", date:"2026-06-28T02:30:00Z", group:"L", round:"Group Stage", stadium:"Philadelphia Stadium", city:"Philadelphia"},
  
  // ═══════════════════════════════════════════════════════
  // ROUND OF 32 - 16 Matches
  // ═══════════════════════════════════════════════════════
  {id:73, home:"2A", away:"2B", date:"2026-06-29T00:30:00Z", round:"Round of 32", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:74, home:"1C", away:"2F", date:"2026-06-29T22:30:00Z", round:"Round of 32", stadium:"Houston Stadium", city:"Houston"},
  {id:75, home:"1E", away:"3ABCDF", date:"2026-06-30T02:00:00Z", round:"Round of 32", stadium:"Boston Stadium", city:"Boston"},
  {id:76, home:"1F", away:"2C", date:"2026-06-30T06:30:00Z", round:"Round of 32", stadium:"Monterrey Stadium", city:"Monterrey"},
  {id:77, home:"2E", away:"2I", date:"2026-06-30T22:30:00Z", round:"Round of 32", stadium:"Dallas Stadium", city:"Dallas"},
  {id:78, home:"1I", away:"3CDFGH", date:"2026-07-01T02:30:00Z", round:"Round of 32", stadium:"New York/New Jersey Stadium", city:"New York"},
  {id:79, home:"1A", away:"3CEFHI", date:"2026-07-01T06:30:00Z", round:"Round of 32", stadium:"Mexico City Stadium", city:"Mexico City"},
  {id:80, home:"1L", away:"3EHIJK", date:"2026-07-01T21:30:00Z", round:"Round of 32", stadium:"Atlanta Stadium", city:"Atlanta"},
  {id:81, home:"1G", away:"3AEHIJ", date:"2026-07-02T01:30:00Z", round:"Round of 32", stadium:"Seattle Stadium", city:"Seattle"},
  {id:82, home:"1D", away:"3BEFIJ", date:"2026-07-02T05:30:00Z", round:"Round of 32", stadium:"San Francisco Bay Area Stadium", city:"San Francisco Bay Area"},
  {id:83, home:"1H", away:"2J", date:"2026-07-03T00:30:00Z", round:"Round of 32", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:84, home:"2K", away:"2L", date:"2026-07-03T04:30:00Z", round:"Round of 32", stadium:"Toronto Stadium", city:"Toronto"},
  {id:85, home:"1B", away:"3EFGIJ", date:"2026-07-03T08:30:00Z", round:"Round of 32", stadium:"BC Place Vancouver", city:"Vancouver"},
  {id:86, home:"2D", away:"2G", date:"2026-07-03T23:30:00Z", round:"Round of 32", stadium:"Dallas Stadium", city:"Dallas"},
  {id:87, home:"1J", away:"2H", date:"2026-07-04T03:30:00Z", round:"Round of 32", stadium:"Miami Stadium", city:"Miami"},
  {id:88, home:"1K", away:"3DEIJL", date:"2026-07-04T07:00:00Z", round:"Round of 32", stadium:"Kansas City Stadium", city:"Kansas City"},
  
  // ═══════════════════════════════════════════════════════
  // ROUND OF 16 - 8 Matches
  // ═══════════════════════════════════════════════════════
  {id:89, home:"W73", away:"W75", date:"2026-07-04T22:30:00Z", round:"Round of 16", stadium:"Houston Stadium", city:"Houston"},
  {id:90, home:"W74", away:"W77", date:"2026-07-05T02:30:00Z", round:"Round of 16", stadium:"Philadelphia Stadium", city:"Philadelphia"},
  {id:91, home:"W76", away:"W78", date:"2026-07-06T01:30:00Z", round:"Round of 16", stadium:"New York/New Jersey Stadium", city:"New York"},
  {id:92, home:"W79", away:"W80", date:"2026-07-06T05:30:00Z", round:"Round of 16", stadium:"Mexico City Stadium", city:"Mexico City"},
  {id:93, home:"W83", away:"W84", date:"2026-07-07T00:30:00Z", round:"Round of 16", stadium:"Dallas Stadium", city:"Dallas"},
  {id:94, home:"W81", away:"W82", date:"2026-07-07T05:30:00Z", round:"Round of 16", stadium:"Seattle Stadium", city:"Seattle"},
  {id:95, home:"W86", away:"W88", date:"2026-07-07T21:30:00Z", round:"Round of 16", stadium:"Atlanta Stadium", city:"Atlanta"},
  {id:96, home:"W85", away:"W87", date:"2026-07-08T01:30:00Z", round:"Round of 16", stadium:"BC Place Vancouver", city:"Vancouver"},
  
  // ═══════════════════════════════════════════════════════
  // QUARTER-FINALS - 4 Matches
  // ═══════════════════════════════════════════════════════
  {id:97, home:"W89", away:"W90", date:"2026-07-10T01:30:00Z", round:"Quarter-final", stadium:"Boston Stadium", city:"Boston"},
  {id:98, home:"W93", away:"W94", date:"2026-07-11T00:30:00Z", round:"Quarter-final", stadium:"Los Angeles Stadium", city:"Los Angeles"},
  {id:99, home:"W91", away:"W92", date:"2026-07-12T02:30:00Z", round:"Quarter-final", stadium:"Miami Stadium", city:"Miami"},
  {id:100, home:"W95", away:"W96", date:"2026-07-12T06:30:00Z", round:"Quarter-final", stadium:"Kansas City Stadium", city:"Kansas City"},
  
  // ═══════════════════════════════════════════════════════
  // SEMI-FINALS - 2 Matches
  // ═══════════════════════════════════════════════════════
  {id:101, home:"W97", away:"W98", date:"2026-07-15T00:30:00Z", round:"Semi-final", stadium:"Dallas Stadium", city:"Dallas"},
  {id:102, home:"W99", away:"W100", date:"2026-07-16T00:30:00Z", round:"Semi-final", stadium:"Atlanta Stadium", city:"Atlanta"},
  
  // ═══════════════════════════════════════════════════════
  // THIRD PLACE & FINAL
  // ═══════════════════════════════════════════════════════
  {id:103, home:"RU101", away:"RU102", date:"2026-07-19T02:30:00Z", round:"Third Place", stadium:"Miami Stadium", city:"Miami"},
  {id:104, home:"W101", away:"W102", date:"2026-07-20T00:30:00Z", round:"Final", stadium:"New York/New Jersey Stadium", city:"New York"}
];

async function fetchAndCacheMatches() {
  console.log("📅 Loading World Cup 2026 fixtures...");
  
  let stored = 0;
  for (const f of WC2026_FIXTURES) {
    const startTime = Math.floor(new Date(f.date).getTime() / 1000);
    
    try {
      await query(
        `INSERT INTO matches
           (id, home_team, away_team, start_time, status, home_score, away_score,
            winner, competition_code, competition_name, group_name, round, stadium, city, season, matchday)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           home_team = EXCLUDED.home_team,
           away_team = EXCLUDED.away_team,
           start_time = EXCLUDED.start_time,
           last_updated = CURRENT_TIMESTAMP`,
        [f.id, f.home, f.away, startTime, "SCHEDULED", 0, 0, null,
         "WC", "FIFA World Cup 2026", f.group || null, f.round || null,
         f.stadium || null, f.city || null, "2026", f.id]
      );
      stored++;
    } catch (e) { 
      console.error(`❌ Error storing match ${f.id}:`, e.message); 
    }
  }

  console.log(`✅ Stored ${stored}/104 World Cup matches in DB`);
  return stored;
}

// ─── Match Results Fetching ──────────────────────────────────────────────────

function determineWinner(homeScore, awayScore) {
  if (homeScore > awayScore) return 'HOME_WIN';
  if (homeScore < awayScore) return 'AWAY_WIN';
  return 'DRAW';
}

async function fetchFromFootballData(match) {
  try {
    const response = await axios.get(
      `https://api.football-data.org/v4/matches?ids=${match.id}`,
      { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } }
    );

    const result = response.data.matches?.[0];
    if (!result) return;

    if (result.status === 'FINISHED') {
      const homeScore = result.score.fullTime.home ?? 0;
      const awayScore = result.score.fullTime.away ?? 0;
      await updateMatchResult(match.id, {
        homeScore, awayScore,
        status: 'FINISHED',
        winner: determineWinner(homeScore, awayScore)
      });
      console.log(`✅ Match ${match.id}: ${match.home_team} ${homeScore}-${awayScore} ${match.away_team}`);
    } else if (result.status === 'IN_PLAY' || result.status === 'PAUSED') {
      await updateMatchResult(match.id, {
        homeScore: result.score.fullTime?.home ?? 0,
        awayScore: result.score.fullTime?.away ?? 0,
        status: result.status,
        winner: null
      });
    }
  } catch (err) {
    if (err.response?.status !== 404) console.error(`⚠️ Error fetching match ${match.id}:`, err.message);
  }
}

async function fetchFromApiFootball(match) {
  try {
    const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: { 'x-apisports-key': API_FOOTBALL_KEY },
      params: { id: match.id }
    });

    const fixture = response.data.response?.[0];
    if (!fixture) return;

    const status = fixture.fixture?.status?.short;
    const homeScore = fixture.goals?.home ?? 0;
    const awayScore = fixture.goals?.away ?? 0;

    if (status === 'FT' || status === 'AET' || status === 'PEN') {
      await updateMatchResult(match.id, {
        homeScore, awayScore,
        status: 'FINISHED',
        winner: determineWinner(homeScore, awayScore)
      });
      console.log(`✅ Match ${match.id}: ${match.home_team} ${homeScore}-${awayScore} ${match.away_team}`);
    } else if (['1H', 'HT', '2H', 'ET', 'P', 'LIVE'].includes(status)) {
      await updateMatchResult(match.id, {
        homeScore, awayScore,
        status: 'IN_PLAY',
        winner: null
      });
    }
  } catch (err) {
    if (err.response?.status !== 404) console.error(`⚠️ Error fetching match ${match.id}:`, err.message);
  }
}

async function updateMatchResult(matchId, result) {
  try {
    await query(
      `UPDATE matches 
       SET home_score = $1, away_score = $2, status = $3, winner = $4, last_updated = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [result.homeScore, result.awayScore, result.status, result.winner, matchId]
    );
  } catch (err) {
    console.error(`❌ Error updating match ${matchId}:`, err.message);
  }
}

async function fetchMatchResults() {
  const now = Math.floor(Date.now() / 1000);
  const matches = await query(
    `SELECT * FROM matches 
     WHERE start_time <= $1 + 900 
     AND start_time >= $2 - 10800
     AND status IN ('SCHEDULED', 'IN_PLAY', 'PAUSED')
     ORDER BY start_time ASC`,
    [now, now]
  );

  if (matches.rows.length === 0) return;

  console.log(`🎯 Fetching results for ${matches.rows.length} matches...`);

  for (const match of matches.rows) {
    if (FOOTBALL_DATA_KEY) await fetchFromFootballData(match);
    else if (API_FOOTBALL_KEY) await fetchFromApiFootball(match);
  }
}

// ─── AI Agent ─────────────────────────────────────────────────────────────────
const aiAgent = new AIMatchAgent({ geminiApiKey: GEMINI_API_KEY });
console.log("🤖 AI Agent ready");

async function getCachedPrediction(key) {
  try {
    const r = await query(
      "SELECT prediction FROM ai_predictions WHERE cache_key=$1 AND expires_at > NOW()",
      [key]
    );
    if (r.rows.length > 0) {
      console.log(`💾 Cache hit: ${key}`);
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
         prediction = EXCLUDED.prediction,
         created_at = NOW(),
         expires_at = NOW() + INTERVAL '30 minutes'`,
      [key, JSON.stringify(prediction)]
    );
  } catch (e) { console.warn("⚠️ AI cache write failed:", e.message); }
}

function formatMatch(row) {
  return {
    id: row.id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    startTime: row.start_time,
    status: row.status,
    competition: { code: row.competition_code, name: row.competition_name },
    group: row.group_name,
    round: row.round,
    stadium: row.stadium,
    city: row.city,
    score: row.home_score !== null ? `${row.home_score} - ${row.away_score}` : null,
    homeScore: row.home_score,
    awayScore: row.away_score,
    winner: row.winner,
    settled: row.status === 'FINISHED',
    bettingOpen: row.status === 'SCHEDULED',
    betDeadline: row.start_time - 300
  };
}

// ─── Contract Automation ──────────────────────────────────────────────────────
async function autoCreateMatchesOnChain() {
  if (!bettingContract) return;

  try {
    const count = await bettingContract.matchCount();
    const onChainCount = Number(count);
    
    if (onChainCount >= 72) {
      console.log(`📊 ${onChainCount} matches already on-chain - skipping creation`);
      return;
    }
    
    console.log(`📊 ${onChainCount} matches on-chain, creating missing...`);
    
    const { rows } = await query(
      "SELECT * FROM matches WHERE round = 'Group Stage' ORDER BY id"
    );
    
    let created = 0;
    
    for (const match of rows) {
      if (match.id - 1 < onChainCount) continue;
      
      try {
        const betDeadline = match.start_time - 300;
        const tx = await bettingContract.createMatch(
          match.home_team, match.away_team, match.start_time, betDeadline
        );
        await tx.wait();
        created++;
        console.log(`✅ On-chain: ${match.id} ${match.home_team} vs ${match.away_team}`);
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.warn(`⚠️ Match ${match.id}:`, e.message?.slice(0, 60));
      }
    }
    
    if (created > 0) console.log(`🎉 Created ${created} new matches`);
    
  } catch (err) {
    console.error('❌ autoCreateMatchesOnChain error:', err.message);
  }
}

async function autoSettleMatchesOnChain() {
  if (!bettingContract) return;

  try {
    const { rows } = await query(
      "SELECT * FROM matches WHERE status = 'FINISHED' AND winner IS NOT NULL AND winner != ''"
    );

    if (rows.length === 0) return;

    console.log(`🎯 Found ${rows.length} finished matches to check`);

    for (const match of rows) {
      try {
        const contractMatch = await bettingContract.getMatch(match.id);
        if (contractMatch[5]) {
          console.log(`⏭️ Match ${match.id} already settled on-chain`);
          continue;
        }

        const outcomeMap = { 'HOME_WIN': 1, 'DRAW': 2, 'AWAY_WIN': 3 };
        const outcome = outcomeMap[match.winner];
        if (!outcome) continue;

        console.log(`🤖 Settling match ${match.id}: ${match.home_team} vs ${match.away_team} → ${match.winner}`);
        const tx = await bettingContract.settleMatch(match.id, outcome);
        await tx.wait();
        console.log(`✅ Match ${match.id} settled on-chain`);
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        if (e.message?.includes('already settled')) {
          console.log(`⏭️ Match ${match.id} already settled`);
        } else if (!e.message?.includes('match not started')) {
          console.error(`❌ Settle match ${match.id} failed:`, e.message?.slice(0, 100));
        }
      }
    }
  } catch (err) {
    console.error('❌ autoSettleMatchesOnChain error:', err.message);
  }
}

async function autoSettleUltimateOnChain() {
  if (!bettingContract) return;

  try {
    const { rows } = await query(
      "SELECT * FROM betting_settings WHERE id = 1 AND ultimate_settled = TRUE AND ultimate_winner IS NOT NULL"
    );

    if (!rows.length) return;

    const winner = rows[0].ultimate_winner;

    try {
      const isSettled = await bettingContract.ultimateSettled();
      if (isSettled) {
        console.log('🏆 Ultimate already settled on-chain');
        return;
      }

      console.log(`🤖 Settling Ultimate: ${winner}`);
      const tx = await bettingContract.settleUltimate(winner);
      await tx.wait();
      console.log(`✅ Ultimate settled on-chain: ${winner}`);
    } catch (e) {
      if (!e.message?.includes('already settled')) {
        console.error('❌ Ultimate settle failed:', e.message?.slice(0, 100));
      }
    }
  } catch (err) {
    console.error('❌ autoSettleUltimateOnChain error:', err.message);
  }
}

async function runAutomation() {
  if (!bettingContract) return;
  console.log('🤖 Running automation...');
  try { await autoCreateMatchesOnChain(); } catch (e) { console.error('❌ createMatches error:', e.message); }
  try { await autoSettleMatchesOnChain(); } catch (e) { console.error('❌ settleMatches error:', e.message); }
  try { await autoSettleUltimateOnChain(); } catch (e) { console.error('❌ settleUltimate error:', e.message); }
  console.log('✅ Automation complete');
}

// ════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.json({
  name: "World Cup 2026 API",
  description: "Official 104-match schedule with live result fetching",
  endpoints: {
    matches: "GET /api/matches",
    match: "GET /api/matches/:id",
    live: "GET /api/matches/live",
    analyze: "GET /api/analyze?home=Brazil&away=Argentina",
    aiAnalyze: "GET /api/ai/analyze/:matchId",
    stats: "GET /api/stats",
    userBets: "GET /api/user/:address/bets",
    placeBet: "POST /api/bets",
    leaderboard: "GET /api/leaderboard",
    ultimate: "GET /api/ultimate",
    resultInput: "POST /api/matches/:id/result",
    refresh: "POST /api/refresh",
    fetchResults: "POST /api/fetch-results",
    health: "GET /api/health"
  }
}));

app.get("/api/health", async (req, res) => {
  try {
    const r = await query("SELECT COUNT(*) FROM matches");
    res.json({ 
      status: "ok", 
      matchesInDB: parseInt(r.rows[0].count),
      timestamp: new Date().toISOString() 
    });
  } catch (err) { 
    res.json({ status: "ok", matchesInDB: 0, error: err.message }); 
  }
});

app.post("/api/admin/run-automation", async (req, res) => {
  try {
    await runAutomation();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/matches", async (req, res) => {
  try {
    const { group, round, status } = req.query;
    let sql = "SELECT * FROM matches WHERE 1=1";
    const params = [];
    let paramCount = 1;
    
    if (group) { sql += ` AND group_name = $${paramCount++}`; params.push(group); }
    if (round) { sql += ` AND round = $${paramCount++}`; params.push(round); }
    if (status) { sql += ` AND status = $${paramCount++}`; params.push(status); }
    
    sql += " ORDER BY start_time ASC";
    const r = await query(sql, params);
    
    res.json({ 
      matches: r.rows.map(formatMatch), 
      total: r.rows.length
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get("/api/matches/live", async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const matches = await query(
      `SELECT * FROM matches 
       WHERE (start_time BETWEEN $1 AND $2 AND status = 'SCHEDULED')
          OR status IN ('IN_PLAY', 'PAUSED')
          OR (status = 'FINISHED' AND last_updated > NOW() - INTERVAL '2 hours')
       ORDER BY start_time ASC`,
      [now - 900, now + 7200]
    );
    res.json({ matches: matches.rows.map(formatMatch), total: matches.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/matches/:id", async (req, res) => {
  try {
    const r = await query("SELECT * FROM matches WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Match not found" });
    res.json({ match: formatMatch(r.rows[0]) });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post("/api/matches/:id/result", async (req, res) => {
  const { homeScore, awayScore, status: matchStatus } = req.body;
  const matchId = parseInt(req.params.id);
  
  if (isNaN(matchId)) return res.status(400).json({ error: "Invalid match ID" });
  if (homeScore === undefined || awayScore === undefined) {
    return res.status(400).json({ error: "homeScore and awayScore required" });
  }
  
  try {
    const match = await query("SELECT * FROM matches WHERE id = $1", [matchId]);
    if (!match.rows.length) return res.status(404).json({ error: "Match not found" });
    
    const status = matchStatus || 'FINISHED';
    const winner = status === 'FINISHED' ? determineWinner(homeScore, awayScore) : null;
    await updateMatchResult(matchId, { homeScore, awayScore, status, winner });
    const updated = await query("SELECT * FROM matches WHERE id = $1", [matchId]);
    res.json({ success: true, match: formatMatch(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const [matches, bets, users, volume] = await Promise.all([
      query("SELECT COUNT(*) FROM matches"),
      query("SELECT COUNT(*) FROM bets"),
      query("SELECT COUNT(DISTINCT user_address) FROM bets"),
      query("SELECT COALESCE(SUM(CAST(amount AS DECIMAL)), 0) as total FROM bets")
    ]);
    res.json({
      matchCount: parseInt(matches.rows[0].count),
      totalBets: parseInt(bets.rows[0].count),
      uniqueUsers: parseInt(users.rows[0].count),
      totalVolumeCLUTCH: volume.rows[0].total || 0
    });
  } catch {
    res.json({ matchCount: 104, totalBets: 0, uniqueUsers: 0, totalVolumeCLUTCH: 0 });
  }
});

app.get("/api/user/:address/bets", async (req, res) => {
  try {
    const [matchBets, ultimateBets] = await Promise.all([
      query(`SELECT b.*, m.home_team, m.away_team, m.winner as match_outcome, m.status as match_status FROM bets b LEFT JOIN matches m ON b.match_id = m.id WHERE b.user_address = $1 ORDER BY b.created_at DESC`, [req.params.address.toLowerCase()]),
      query("SELECT * FROM ultimate_bets WHERE user_address = $1 ORDER BY created_at DESC", [req.params.address.toLowerCase()])
    ]);
    res.json({ matchBets: matchBets.rows, ultimateBets: ultimateBets.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bets", async (req, res) => {
  const { matchId, userAddress, prediction, amount, txHash } = req.body;
  if (!matchId || !userAddress || !prediction || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    const result = await query(
      "INSERT INTO bets (match_id, user_address, prediction, amount, tx_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [matchId, userAddress.toLowerCase(), prediction, amount.toString(), txHash || null]
    );
    res.json({ success: true, betId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ultimate-bets", async (req, res) => {
  const { userAddress, team, amount, txHash } = req.body;
  if (!userAddress || !team || !amount) return res.status(400).json({ error: "Missing required fields" });
  try {
    await query("INSERT INTO ultimate_bets (user_address, team, amount, tx_hash) VALUES ($1, $2, $3, $4)", [userAddress.toLowerCase(), team, amount.toString(), txHash || null]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const r = await query(
      `SELECT user_address as user, COUNT(*) as bet_count, COALESCE(SUM(CAST(amount AS DECIMAL)), 0) as total_wagered, COUNT(CASE WHEN claimed = true THEN 1 END) as wins_claimed FROM bets GROUP BY user_address ORDER BY total_wagered DESC LIMIT 20`
    );
    res.json({ leaderboard: r.rows });
  } catch {
    res.json({ leaderboard: [] });
  }
});

app.get("/api/ultimate", async (req, res) => {
  try {
    const [total, teams, settings] = await Promise.all([
      query("SELECT COALESCE(SUM(CAST(amount AS DECIMAL)), 0) as total FROM ultimate_bets"),
      query("SELECT team, SUM(CAST(amount AS DECIMAL)) as amount FROM ultimate_bets GROUP BY team ORDER BY amount DESC"),
      query("SELECT * FROM betting_settings WHERE id = 1")
    ]);
    const s = settings.rows[0] || {};
    res.json({
      deadline: s.ultimate_deadline || 1784577000,
      settled: s.ultimate_settled || false,
      winner: s.ultimate_winner || null,
      totalPool: total.rows[0].total || "0",
      teamPools: teams.rows
    });
  } catch {
    res.json({ deadline: 1784577000, settled: false, winner: null, totalPool: "0", teamPools: [] });
  }
});

app.post("/api/ultimate/settle", async (req, res) => {
  const { winner } = req.body;
  if (!winner) return res.status(400).json({ error: "winner required" });
  try {
    await query("UPDATE betting_settings SET ultimate_settled = true, ultimate_winner = $1 WHERE id = 1", [winner]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/analyze", async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) return res.status(400).json({ error: "Provide home and away" });
  const key = `predict:${home.toLowerCase()}:${away.toLowerCase()}`;
  try {
    const cached = await getCachedPrediction(key);
    if (cached) return res.json(cached);
    const result = await aiAgent.predict(home, away);
    await savePrediction(key, result);
    res.json(result);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get("/api/ai/analyze/:matchId", async (req, res) => {
  try {
    const r = await query("SELECT * FROM matches WHERE id=$1", [req.params.matchId]);
    if (!r.rows.length) return res.status(404).json({ error: "Match not found" });
    const m = r.rows[0];
    const key = `predict:${m.home_team.toLowerCase()}:${m.away_team.toLowerCase()}`;
    const cached = await getCachedPrediction(key);
    if (cached) return res.json({ matchId: m.id, ...cached });
    const result = await aiAgent.predict(m.home_team, m.away_team);
    await savePrediction(key, result);
    res.json({ matchId: m.id, ...result });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const stored = await fetchAndCacheMatches();
    const total = parseInt((await query("SELECT COUNT(*) FROM matches")).rows[0].count);
    res.json({ success: true, stored, totalMatches: total });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post("/api/fetch-results", async (req, res) => {
  try {
    await fetchMatchResults();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Scheduling ───────────────────────────────────────────────────────────────

function scheduleAutoRefresh() {
  setInterval(async () => {
    try { await fetchAndCacheMatches(); } catch (e) {}
  }, 6 * 60 * 60 * 1000);
  console.log("⏰ Auto-refresh scheduled every 6 hours");
}

function scheduleResultFetching() {
  if (!FOOTBALL_DATA_KEY && !API_FOOTBALL_KEY) {
    console.log("⚠️ No result API keys. Use POST /api/matches/:id/result for manual input.");
    return;
  }
  setInterval(fetchMatchResults, 5 * 60 * 1000);
  console.log("⏰ Live result fetching scheduled every 5 minutes");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log("\n" + "=".repeat(55));
  console.log("🌍 World Cup 2026 API");
  console.log(`🤖 AI: ${GEMINI_API_KEY ? '✅ Google Gemini' : '❌ Missing'}`);
  console.log(`📊 Results: ${FOOTBALL_DATA_KEY ? '✅ football-data.org' : (API_FOOTBALL_KEY ? '✅ api-football' : '⚠️ Manual')}`);
  console.log(`🗄️  DB: ${DATABASE_URL ? '✅ Neon PostgreSQL' : '❌ Missing'}`);
  console.log(`🔗 Contract: ${BETTING_ADDRESS ? '✅ Configured' : '⚠️ Not set'}`);
  console.log("=".repeat(55));

  const matchCount = await initDatabase();

  if (matchCount < 100) {
    console.log("📅 Loading World Cup fixtures...");
    await fetchAndCacheMatches();
  } else {
    console.log(`📊 Serving ${matchCount} World Cup matches from DB`);
  }

  const adminReady = initAdmin();
  scheduleAutoRefresh();
  scheduleResultFetching();

  if (adminReady) {
    setTimeout(runAutomation, 5000);
    setInterval(runAutomation, 5 * 60 * 1000);
    console.log("⏰ Contract automation scheduled every 5 minutes");
  }

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`⚽ Matches : GET /api/matches`);
    console.log(`🤖 Automation : ${adminReady ? '✅ ENABLED' : '⚠️ DISABLED'}`);
    console.log(`📅 Ultimate Deadline: July 20, 2026 00:30 UTC`);
    console.log("=".repeat(55));
  });
}

start().catch(console.error);
module.exports = app;