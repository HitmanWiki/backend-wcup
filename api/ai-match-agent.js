/**
 * AI Match Analysis Agent — Gemini Edition
 * Database-first approach - uses your Neon PostgreSQL before API calls
 */

const axios = require("axios");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { Pool } = require('pg'); // Add this for database access

class AIMatchAgent {
  constructor({ footballApiKey, geminiApiKey, newsApiKey = null, databaseUrl = null }) {
    // ── Clients ────────────────────────────────────────────────────────
    this.genAI = new GoogleGenerativeAI(geminiApiKey);
    this.footballApiKey = footballApiKey;
    this.newsApiKey = newsApiKey;
    this.databaseUrl = databaseUrl;

    this.apiBase = "https://api.football-data.org/v4";
    this.footballHeaders = { "X-Auth-Token": this.footballApiKey };

    // ── Database connection (if provided) ─────────────────────────────
    this.pool = null;
    if (databaseUrl) {
      this.pool = new Pool({ 
        connectionString: databaseUrl, 
        ssl: { rejectUnauthorized: false } 
      });
      console.log("✅ AI Agent connected to database");
    }

    // ── Caches ─────────────────────────────────────────────────────────
    this.teamCache = new Map();      // teamName → teamId
    this.resultCache = new Map();    // cacheKey → { data, expiresAt }
    this.CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

    // ── Agent config ───────────────────────────────────────────────────
    this.model = "gemini-2.5-flash";
    this.maxIterations = 10;
    this.config = {
      homeAdvantage: 1.25,
      formMatchLimit: 6,
      h2hMatchLimit: 8,
      minDataThreshold: 3,
    };

    // ── Tool declarations ─────────────────────────────────────────────
    this.toolDeclarations = [
      {
        name: "get_team_form",
        description: "Fetch a team's recent match results — form string, goals, clean sheets, momentum. Call for BOTH teams first.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            team_name: { type: SchemaType.STRING, description: "Full team name" },
            num_matches: { type: SchemaType.INTEGER, description: "Number of matches (default 6)" },
          },
          required: ["team_name"],
        },
      },
      {
        name: "get_head_to_head",
        description: "Fetch historical head-to-head results between two teams.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            team1: { type: SchemaType.STRING, description: "Home team" },
            team2: { type: SchemaType.STRING, description: "Away team" },
          },
          required: ["team1", "team2"],
        },
      },
      {
        name: "get_league_standings",
        description: "Fetch current league table standings.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            competition_code: { 
              type: SchemaType.STRING, 
              description: "PL, PD, BL1, SA, FL1, CL" 
            },
          },
          required: ["competition_code"],
        },
      },
      {
        name: "search_team_news",
        description: "Search for recent team news — injuries, suspensions, lineup hints.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: { type: SchemaType.STRING, description: "Search query" },
          },
          required: ["query"],
        },
      },
    ];
  }

  // ════════════════════════════════════════════════════════════════════
  //  PUBLIC ENTRY POINT
  // ════════════════════════════════════════════════════════════════════

  async predict(homeTeam, awayTeam, options = {}) {
    const { competition = "Unknown", verbose = false } = options;

    this._log(`\n${"═".repeat(60)}`);
    this._log(`🤖 Gemini Agent: ${homeTeam}  vs  ${awayTeam}`);
    this._log(`${"═".repeat(60)}\n`);

    const model = this.genAI.getGenerativeModel({
      model: this.model,
      tools: [{ functionDeclarations: this.toolDeclarations }],
      systemInstruction: this._systemPrompt(),
    });

    const chat = model.startChat({ history: [] });
    const firstMessage = this._buildPrompt(homeTeam, awayTeam, competition);
    let response = await chat.sendMessage(firstMessage);

    let iterations = 0;
    let finalText = null;

    while (iterations < this.maxIterations) {
      iterations++;
      this._log(`\n── Iteration ${iterations} ──────────────────────────────────`);

      const candidate = response.response.candidates?.[0];
      if (!candidate) break;

      const parts = candidate.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall);
      const textParts = parts.filter((p) => p.text);

      if (functionCalls.length > 0) {
        const toolResponses = [];

        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          this._log(`\n🔧 Tool called: ${name}`);

          let result;
          try {
            result = await this._dispatchTool(name, args);
          } catch (err) {
            result = { error: err.message, isMock: true };
          }

          toolResponses.push({
            functionResponse: {
              name,
              response: { content: result },
            },
          });
        }

        response = await chat.sendMessage(toolResponses);
        continue;
      }

      if (textParts.length > 0) {
        finalText = textParts.map((p) => p.text).join("");
        this._log(`\n✅ Agent finished after ${iterations} iteration(s)`);
        break;
      }

      break;
    }

    if (!finalText) {
      return this._fallbackResult(homeTeam, awayTeam);
    }

    return this._parseGeminiOutput(finalText, homeTeam, awayTeam);
  }

  // ════════════════════════════════════════════════════════════════════
  //  DATABASE-FIRST IMPLEMENTATIONS
  // ════════════════════════════════════════════════════════════════════

  async _getTeamFormFromDB(teamName, numMatches = 6) {
    if (!this.pool) return null;

    try {
      const result = await this.pool.query(
        `SELECT * FROM matches 
         WHERE home_team = $1 OR away_team = $1 
         ORDER BY start_time DESC 
         LIMIT $2`,
        [teamName, numMatches]
      );

      if (result.rows.length === 0) return null;

      const matches = result.rows;
      let form = [];
      let goalsFor = 0, goalsAgainst = 0;

      for (const match of matches) {
        const isHome = match.home_team === teamName;
        const teamScore = isHome ? match.home_score : match.away_score;
        const oppScore = isHome ? match.away_score : match.home_score;
        
        goalsFor += teamScore;
        goalsAgainst += oppScore;

        let result = 'D';
        if (teamScore > oppScore) result = 'W';
        else if (teamScore < oppScore) result = 'L';

        form.push({
          opponent: isHome ? match.away_team : match.home_team,
          result,
          score: `${teamScore}-${oppScore}`,
          date: new Date(match.start_time * 1000).toISOString().split('T')[0],
          isHome
        });
      }

      const formString = form.map(f => f.result).join('');
      const wins = (formString.match(/W/g) || []).length;
      const draws = (formString.match(/D/g) || []).length;

      return {
        team: teamName,
        formString,
        formScore: +((wins * 3 + draws) / (numMatches * 3) * 100).toFixed(1),
        record: { 
          wins, 
          draws, 
          losses: numMatches - wins - draws,
          points: wins * 3 + draws 
        },
        goals: {
          avgScored: +(goalsFor / numMatches).toFixed(2),
          avgConceded: +(goalsAgainst / numMatches).toFixed(2),
        },
        momentum: this._analyzeTrend(formString),
        recentMatches: form,
        source: 'database'
      };
    } catch (err) {
      console.error("DB form error:", err.message);
      return null;
    }
  }

  async _getH2HFromDB(team1, team2) {
    if (!this.pool) return null;

    try {
      const result = await this.pool.query(
        `SELECT * FROM matches 
         WHERE (home_team = $1 AND away_team = $2) 
            OR (home_team = $2 AND away_team = $1)
         ORDER BY start_time DESC`,
        [team1, team2]
      );

      if (result.rows.length < 2) return null;

      const matches = result.rows;
      let team1Wins = 0, team2Wins = 0, draws = 0;
      let team1Goals = 0, team2Goals = 0;

      for (const match of matches) {
        const isTeam1Home = match.home_team === team1;
        const t1Score = isTeam1Home ? match.home_score : match.away_score;
        const t2Score = isTeam1Home ? match.away_score : match.home_score;

        team1Goals += t1Score;
        team2Goals += t2Score;

        if (t1Score > t2Score) team1Wins++;
        else if (t1Score < t2Score) team2Wins++;
        else draws++;
      }

      return {
        teams: { team1, team2 },
        totalMatches: matches.length,
        record: { team1Wins, team2Wins, draws },
        rates: {
          team1WinRate: +((team1Wins / matches.length) * 100).toFixed(1),
          team2WinRate: +((team2Wins / matches.length) * 100).toFixed(1),
          drawRate: +((draws / matches.length) * 100).toFixed(1),
        },
        goals: { team1Total: team1Goals, team2Total: team2Goals },
        advantage: team1Wins > team2Wins ? team1 : team2Wins > team1Wins ? team2 : "Balanced",
        source: 'database'
      };
    } catch (err) {
      console.error("DB H2H error:", err.message);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  TOOL DISPATCHER (Modified to try DB first)
  // ════════════════════════════════════════════════════════════════════

  async _dispatchTool(name, args) {
    switch (name) {
      case "get_team_form": {
        const teamName = args.team_name;
        const numMatches = args.num_matches || this.config.formMatchLimit;
        
        // Try database first
        if (this.pool) {
          const dbForm = await this._getTeamFormFromDB(teamName, numMatches);
          if (dbForm) return dbForm;
        }
        
        // Fall back to API
        return this._getTeamForm(teamName, numMatches);
      }
      
      case "get_head_to_head": {
        const { team1, team2 } = args;
        
        // Try database first
        if (this.pool) {
          const dbH2H = await this._getH2HFromDB(team1, team2);
          if (dbH2H) return dbH2H;
        }
        
        // Fall back to API
        return this._getHeadToHead(team1, team2);
      }
      
      case "get_league_standings":
        return this._getLeagueStandings(args.competition_code);
        
      case "search_team_news":
        return this._searchTeamNews(args.query);
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  ORIGINAL API METHODS (Keep as fallbacks)
  // ════════════════════════════════════════════════════════════════════

  async _getTeamForm(teamName, numMatches = 6) {
    const cacheKey = `form:${teamName}:${numMatches}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    const teamId = await this._findTeamId(teamName);
    if (!teamId) {
      this._log(`   ⚠️ Team not found in API: ${teamName}, using mock`);
      return this._mockForm(teamName, numMatches);
    }

    try {
      const resp = await axios.get(
        `${this.apiBase}/teams/${teamId}/matches?limit=20&status=FINISHED`,
        { headers: this.footballHeaders, timeout: 8000 }
      );

      const matches = (resp.data.matches || []).slice(0, numMatches);
      if (matches.length === 0) return this._mockForm(teamName, numMatches);

      // ... (rest of your existing form calculation code)
      // Keep your existing implementation here
      let wins = 0, draws = 0, losses = 0;
      let goalsFor = 0, goalsAgainst = 0, cleanSheets = 0;
      const form = [];

      matches.forEach((m, i) => {
        const isHome = m.homeTeam.id === teamId;
        const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
        const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;

        goalsFor += gf;
        goalsAgainst += ga;
        if (ga === 0) cleanSheets++;

        let result;
        if (gf > ga) { result = "W"; wins++; }
        else if (gf < ga) { result = "L"; losses++; }
        else { result = "D"; draws++; }

        form.push({
          matchday: i + 1,
          opponent: isHome ? m.awayTeam.name : m.homeTeam.name,
          venue: isHome ? "H" : "A",
          result,
          score: `${gf}-${ga}`,
          date: m.utcDate.split("T")[0],
          goalDiff: gf - ga,
        });
      });

      const n = matches.length;
      const formString = form.map((f) => f.result).join("");

      let weightedPts = 0, totalWeight = 0;
      form.forEach((f, i) => {
        const w = n - i;
        totalWeight += w * 3;
        if (f.result === "W") weightedPts += w * 3;
        else if (f.result === "D") weightedPts += w;
      });
      const formScore = totalWeight > 0 ? (weightedPts / totalWeight) * 100 : 50;

      const last3 = form.slice(0, 3).map((f) => f.result);
      const momentum =
        last3.filter((r) => r === "W").length >= 2 ? "positive" :
        last3.filter((r) => r === "L").length >= 2 ? "negative" : "neutral";

      const result = {
        team: teamName,
        formString,
        formScore: +formScore.toFixed(1),
        record: { wins, draws, losses, points: wins * 3 + draws, maxPoints: n * 3 },
        goals: {
          scored: goalsFor,
          conceded: goalsAgainst,
          avgScored: +(goalsFor / n).toFixed(2),
          avgConceded: +(goalsAgainst / n).toFixed(2),
          cleanSheets,
          cleanSheetRate: +((cleanSheets / n) * 100).toFixed(1),
        },
        momentum,
        recentMatches: form,
        source: 'api',
        isMock: false,
      };

      this._setCache(cacheKey, result);
      return result;
    } catch (error) {
      this._log(`   ⚠️ API error for ${teamName}, using mock`);
      return this._mockForm(teamName, numMatches);
    }
  }

  async _getHeadToHead(team1Name, team2Name) {
    const cacheKey = `h2h:${team1Name}:${team2Name}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    const [team1Id, team2Id] = await Promise.all([
      this._findTeamId(team1Name),
      this._findTeamId(team2Name),
    ]);

    if (!team1Id || !team2Id) return this._mockH2H(team1Name, team2Name);

    try {
      const resp = await axios.get(
        `${this.apiBase}/teams/${team1Id}/matches?limit=50&status=FINISHED`,
        { headers: this.footballHeaders, timeout: 8000 }
      );

      const h2hMatches = (resp.data.matches || [])
        .filter((m) => m.homeTeam.id === team2Id || m.awayTeam.id === team2Id)
        .slice(0, this.config.h2hMatchLimit);

      if (h2hMatches.length < this.config.minDataThreshold) {
        return { ...this._mockH2H(team1Name, team2Name), note: "Insufficient real H2H data" };
      }

      // ... (rest of your existing H2H calculation)
      // Keep your existing implementation here
      let t1Wins = 0, t2Wins = 0, draws = 0;
      let t1Goals = 0, t2Goals = 0;
      let weightedDom = 0;
      const recent = [];
      const total = h2hMatches.length;

      h2hMatches.forEach((m, i) => {
        const isT1Home = m.homeTeam.id === team1Id;
        const t1Score = isT1Home ? m.score.fullTime.home : m.score.fullTime.away;
        const t2Score = isT1Home ? m.score.fullTime.away : m.score.fullTime.home;
        const recencyW = total - i;

        t1Goals += t1Score;
        t2Goals += t2Score;

        if (t1Score > t2Score) { t1Wins++; weightedDom += recencyW; }
        else if (t1Score < t2Score) { t2Wins++; weightedDom -= recencyW; }
        else { draws++; }

        if (i < 5) {
          recent.push({
            date: m.utcDate.split("T")[0],
            home: m.homeTeam.name,
            away: m.awayTeam.name,
            score: `${m.score.fullTime.home}-${m.score.fullTime.away}`,
            winner: m.score.fullTime.home > m.score.fullTime.away ? m.homeTeam.name :
                    m.score.fullTime.home < m.score.fullTime.away ? m.awayTeam.name : "Draw",
          });
        }
      });

      const maxWeight = (total * (total + 1)) / 2;
      const dominanceScore = 50 + (weightedDom / maxWeight) * 50;

      const result = {
        teams: { team1: team1Name, team2: team2Name },
        totalMatches: total,
        record: { team1Wins: t1Wins, team2Wins: t2Wins, draws },
        rates: {
          team1WinRate: +((t1Wins / total) * 100).toFixed(1),
          team2WinRate: +((t2Wins / total) * 100).toFixed(1),
          drawRate: +((draws / total) * 100).toFixed(1),
        },
        goals: {
          team1Total: t1Goals,
          team2Total: t2Goals,
          avgPerMatch: +((t1Goals + t2Goals) / total).toFixed(2),
        },
        dominanceScore: +dominanceScore.toFixed(1),
        advantage: t1Wins > t2Wins ? team1Name : t2Wins > t1Wins ? team2Name : "Balanced",
        recentMeetings: recent,
        reliability: total >= 5 ? "high" : "medium",
        source: 'api',
        isMock: false,
      };

      this._setCache(cacheKey, result);
      return result;
    } catch (error) {
      return this._mockH2H(team1Name, team2Name);
    }
  }

  async _getLeagueStandings(competitionCode) {
    const cacheKey = `standings:${competitionCode}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    const resp = await axios.get(
      `${this.apiBase}/competitions/${competitionCode}/standings`,
      { headers: this.footballHeaders, timeout: 8000 }
    );

    const table = resp.data.standings?.[0]?.table || [];

    const result = {
      competition: resp.data.competition?.name || competitionCode,
      season: resp.data.season?.startDate?.split("-")[0],
      standings: table.slice(0, 20).map((row) => ({
        position: row.position,
        team: row.team.name,
        played: row.playedGames,
        won: row.won,
        drawn: row.draw,
        lost: row.lost,
        gf: row.goalsFor,
        ga: row.goalsAgainst,
        gd: row.goalDifference,
        points: row.points,
        form: row.form,
      })),
    };

    this._setCache(cacheKey, result);
    return result;
  }

  async _searchTeamNews(query) {
    if (!this.newsApiKey) {
      return {
        query,
        articles: [],
        note: "Set NEWS_API_KEY for live injury/news data",
      };
    }

    try {
      const resp = await axios.get(
        `https://newsapi.org/v2/everything` +
          `?q=${encodeURIComponent(query)}` +
          `&sortBy=publishedAt&pageSize=5&language=en` +
          `&apiKey=${this.newsApiKey}`,
        { timeout: 6000 }
      );

      const articles = (resp.data.articles || []).map((a) => ({
        title: a.title,
        source: a.source?.name,
        publishedAt: a.publishedAt?.split("T")[0],
        summary: a.description,
      }));

      return { query, articles, count: articles.length };
    } catch (err) {
      return { query, articles: [], error: err.message };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  TEAM ID RESOLUTION (unchanged)
  // ════════════════════════════════════════════════════════════════════

  async _findTeamId(teamName) {
    if (!teamName || typeof teamName !== "string") return null;
    teamName = teamName.trim();

    if (this.teamCache.has(teamName)) return this.teamCache.get(teamName);

    try {
      const resp = await axios.get(
        `${this.apiBase}/teams?name=${encodeURIComponent(teamName)}`,
        { headers: this.footballHeaders, timeout: 5000 }
      );
      if (resp.data.teams?.length > 0) {
        const id = resp.data.teams[0].id;
        this.teamCache.set(teamName, id);
        return id;
      }
    } catch { /* fall through */ }

    try {
      const resp = await axios.get(
        `${this.apiBase}/teams?limit=200`,
        { headers: this.footballHeaders, timeout: 8000 }
      );
      const lower = teamName.toLowerCase();
      const team = (resp.data.teams || []).find(
        (t) =>
          t.name?.toLowerCase() === lower ||
          t.shortName?.toLowerCase() === lower ||
          t.tla?.toLowerCase() === lower ||
          t.name?.toLowerCase().includes(lower) ||
          t.shortName?.toLowerCase().includes(lower)
      );
      if (team) {
        this.teamCache.set(teamName, team.id);
        return team.id;
      }
    } catch { /* fall through */ }

    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  OUTPUT PARSING (unchanged)
  // ════════════════════════════════════════════════════════════════════

  _parseGeminiOutput(text, homeTeam, awayTeam) {
    const jsonMatch =
      text.match(/```json\s*([\s\S]+?)\s*```/) ||
      text.match(/(\{[\s\S]+\})/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          ...parsed,
          _meta: {
            homeTeam,
            awayTeam,
            generatedAt: new Date().toISOString(),
            model: this.model,
          },
        };
      } catch { /* fall through */ }
    }

    return {
      homeTeam,
      awayTeam,
      rawAnalysis: text,
      prediction: { homeWin: null, draw: null, awayWin: null },
      mostLikely: "UNKNOWN",
      confidence: "LOW",
      _parseError: true,
      _meta: { generatedAt: new Date().toISOString(), model: this.model },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  PROMPTS (unchanged)
  // ════════════════════════════════════════════════════════════════════

  _systemPrompt() {
    return `You are an elite football match analyst and sports betting specialist.
Your job is to autonomously gather data using the provided tools and produce a
rigorous, probability-calibrated match prediction.

ANALYSIS PROTOCOL (follow this order):
1. Call get_team_form for the HOME team.
2. Call get_team_form for the AWAY team.
3. Call get_head_to_head for the fixture.
4. Call get_league_standings if positional context would help.
5. Call search_team_news for both teams (injuries, suspensions, lineup news).
6. Synthesise ALL gathered data into a final prediction JSON.

BETTING SPECIALIST NOTES:
- Identify value bets where your probability exceeds typical bookmaker implied odds.
- Suggest Over/Under goal line based on attack strength and defensive record.
- Estimate BTTS (Both Teams To Score) from clean sheet rates and avg goals.
- Suggest Asian Handicap line when one team is a clear favourite.
- Flag any bets to AVOID due to uncertainty or conflicting signals.

OUTPUT FORMAT — return ONLY this JSON block, nothing else:

\`\`\`json
{
  "homeTeam": "string",
  "awayTeam": "string",
  "competition": "string",
  "prediction": {
    "homeWin": 0.0,
    "draw": 0.0,
    "awayWin": 0.0
  },
  "mostLikely": "HOME_WIN | DRAW | AWAY_WIN",
  "confidence": "HIGH | MEDIUM | LOW",
  "expectedGoals": {
    "home": 0.0,
    "away": 0.0,
    "total": 0.0
  },
  "bettingAngles": {
    "recommendedBet": "string",
    "valueBet": "string or null",
    "btts": "YES | NO | UNCERTAIN",
    "bttsConfidence": "HIGH | MEDIUM | LOW",
    "overUnderLine": 2.5,
    "overUnderCall": "OVER | UNDER | UNCERTAIN",
    "asianHandicap": "string or null",
    "avoidBets": ["list"]
  },
  "keyFactors": ["factor 1", "factor 2", "factor 3"],
  "riskFactors": ["risk 1"],
  "formSummary": {
    "homeTeamForm": "string",
    "awayTeamForm": "string",
    "homeMomentum": "positive | neutral | negative",
    "awayMomentum": "positive | neutral | negative"
  },
  "h2hSummary": "one sentence",
  "injuryOrNewsAlert": "string or null",
  "analystNote": "2-3 sentence deeper insight",
  "dataQuality": "HIGH | MEDIUM | LOW",
  "warningFlags": ["any data or external factor concerns"]
}
\`\`\`

RULES:
- prediction values must sum to exactly 100.
- Be a sharp analyst. Do not be optimistic — calibrate probabilities carefully.
- Do NOT output any text outside the JSON block.`;
  }

  _buildPrompt(homeTeam, awayTeam, competition) {
    return (
      `Analyse the upcoming match:\n\n` +
      `HOME TEAM : ${homeTeam}\n` +
      `AWAY TEAM : ${awayTeam}\n` +
      `COMPETITION: ${competition}\n\n` +
      `Follow your analysis protocol. Start with get_team_form for both teams.`
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  CACHE HELPERS (unchanged)
  // ════════════════════════════════════════════════════════════════════

  _getCache(key) {
    const entry = this.resultCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.resultCache.delete(key);
      return null;
    }
    return entry.data;
  }

  _setCache(key, data) {
    this.resultCache.set(key, { data, expiresAt: Date.now() + this.CACHE_TTL_MS });
  }

  clearCaches() {
    this.teamCache.clear();
    this.resultCache.clear();
    console.log("✓ Caches cleared");
  }

  // ════════════════════════════════════════════════════════════════════
  //  MOCK FALLBACKS (when both DB and API fail)
  // ════════════════════════════════════════════════════════════════════

  _mockForm(teamName, n) {
    const results = ["W", "W", "D", "L", "W", "D"];
    let formString = "";
    const form = [];
    for (let i = 0; i < n; i++) {
      const r = results[i % results.length];
      formString += r;
      form.push({ 
        matchday: i + 1, 
        opponent: "Unknown FC", 
        venue: "H", 
        result: r, 
        score: "1-1", 
        date: "N/A", 
        goalDiff: 0 
      });
    }
    const wins = (formString.match(/W/g) || []).length;
    const draws = (formString.match(/D/g) || []).length;
    return {
      team: teamName,
      formString,
      formScore: +((wins * 3 + draws) / (n * 3) * 100).toFixed(1),
      record: { wins, draws, losses: n - wins - draws, points: wins * 3 + draws },
      goals: { avgScored: 1.4, avgConceded: 1.1, cleanSheetRate: 20 },
      momentum: "neutral",
      recentMatches: form,
      source: 'mock',
      isMock: true,
    };
  }

  _mockH2H(team1, team2) {
    return {
      teams: { team1, team2 },
      totalMatches: 5,
      record: { team1Wins: 2, team2Wins: 2, draws: 1 },
      rates: { team1WinRate: 40, team2WinRate: 40, drawRate: 20 },
      goals: { avgPerMatch: 2.4 },
      dominanceScore: 50,
      advantage: "Balanced",
      recentMeetings: [],
      reliability: "low",
      source: 'mock',
      isMock: true,
    };
  }

  _fallbackResult(homeTeam, awayTeam) {
    return {
      homeTeam,
      awayTeam,
      prediction: { homeWin: 40, draw: 25, awayWin: 35 },
      mostLikely: "HOME_WIN",
      confidence: "LOW",
      bettingAngles: { recommendedBet: "No bet — data unavailable", btts: "UNCERTAIN" },
      keyFactors: ["Agent failed to complete analysis"],
      dataQuality: "LOW",
      _meta: { 
        generatedAt: new Date().toISOString(), 
        model: this.model, 
        fallback: true 
      },
    };
  }

  _log(msg) {
    console.log(msg);
  }
}

module.exports = AIMatchAgent;