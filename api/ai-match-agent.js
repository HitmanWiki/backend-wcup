/**
 * AI Match Analysis Agent — Gemini Edition
 * Brain  : Google Gemini 2.0 Flash (free tier)
 * Data   : football-data.org  +  NewsAPI (both free tiers available)
 * Pattern: Agentic loop — Gemini decides which tools to call and when
 *
 * Setup:
 *   npm install @google/generative-ai axios
 *   GEMINI_API_KEY=...        (https://aistudio.google.com/app/apikey)
 *   FOOTBALL_API_KEY=...      (https://www.football-data.org — free tier)
 *   NEWS_API_KEY=...          (https://newsapi.org — free tier, optional)
 */

const axios = require("axios");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

class AIMatchAgent {
  constructor({ footballApiKey, geminiApiKey, newsApiKey = null }) {
    // ── Clients ────────────────────────────────────────────────────────
    this.genAI = new GoogleGenerativeAI(geminiApiKey);
    this.footballApiKey = footballApiKey;
    this.newsApiKey = newsApiKey;

    this.apiBase = "https://api.football-data.org/v4";
    this.footballHeaders = { "X-Auth-Token": this.footballApiKey };

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

    // ── Tool declarations (Gemini function-calling format) ─────────────
    this.toolDeclarations = [
      {
        name: "get_team_form",
        description:
          "Fetch a team's recent match results — form string (e.g. WWDLW), goals scored/conceded, clean sheets, momentum, and weighted form score. Call this for BOTH home and away teams before doing anything else.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            team_name: {
              type: SchemaType.STRING,
              description: "Full or common name of the team, e.g. 'Manchester City'",
            },
            num_matches: {
              type: SchemaType.INTEGER,
              description: "Number of recent matches to analyse (default 6, max 10)",
            },
          },
          required: ["team_name"],
        },
      },
      {
        name: "get_head_to_head",
        description:
          "Fetch historical head-to-head results between two teams: wins, draws, losses, goals, dominance score, and the most recent meetings. Call this after fetching individual team forms.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            team1: {
              type: SchemaType.STRING,
              description: "Home team name",
            },
            team2: {
              type: SchemaType.STRING,
              description: "Away team name",
            },
          },
          required: ["team1", "team2"],
        },
      },
      {
        name: "get_league_standings",
        description:
          "Fetch current league table standings. Useful to understand a team's position, points gap, and league trajectory.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            competition_code: {
              type: SchemaType.STRING,
              description:
                "Code: PL (Premier League), PD (La Liga), BL1 (Bundesliga), SA (Serie A), FL1 (Ligue 1), CL (Champions League)",
            },
          },
          required: ["competition_code"],
        },
      },
      {
        name: "search_team_news",
        description:
          "Search for recent news about a team — injuries, suspensions, lineup hints, manager comments, squad rotation. Enrich prediction with context the stats alone cannot provide.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: {
              type: SchemaType.STRING,
              description:
                "Search query, e.g. 'Manchester City injuries lineup 2025' or 'Arsenal suspension team news'",
            },
          },
          required: ["query"],
        },
      },
    ];
  }

  // ════════════════════════════════════════════════════════════════════
  //  PUBLIC ENTRY POINT
  // ════════════════════════════════════════════════════════════════════

  /**
   * Run the full agentic prediction loop.
   * Gemini decides which tools to call, in what order, how many times.
   *
   * @param {string} homeTeam
   * @param {string} awayTeam
   * @param {object} options  { competition?: string, verbose?: boolean }
   * @returns {Promise<PredictionResult>}
   */
  async predict(homeTeam, awayTeam, options = {}) {
    const { competition = "Unknown", verbose = false } = options;

    this._log(`\n${"═".repeat(60)}`);
    this._log(`🤖  Gemini Agent: ${homeTeam}  vs  ${awayTeam}`);
    this._log(`${"═".repeat(60)}\n`);

    // Initialise Gemini model with tools
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      tools: [{ functionDeclarations: this.toolDeclarations }],
      systemInstruction: this._systemPrompt(),
    });

    // Start a chat session — Gemini maintains history internally
    const chat = model.startChat({ history: [] });

    // First user message
    const firstMessage = this._buildPrompt(homeTeam, awayTeam, competition);
    let response = await chat.sendMessage(firstMessage);

    let iterations = 0;
    let finalText = null;

    // ── Agentic loop ──────────────────────────────────────────────────
    while (iterations < this.maxIterations) {
      iterations++;
      this._log(`\n── Iteration ${iterations} ──────────────────────────────────`);

      const candidate = response.response.candidates?.[0];
      if (!candidate) {
        this._log("⚠️  No candidates returned");
        break;
      }

      const parts = candidate.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall);
      const textParts = parts.filter((p) => p.text);

      // ── Case 1: Gemini wants to call tools ────────────────────────
      if (functionCalls.length > 0) {
        const toolResponses = [];

        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          this._log(`\n🔧  Tool called: ${name}`);
          if (verbose) this._log(`   Args: ${JSON.stringify(args, null, 2)}`);

          let result;
          try {
            result = await this._dispatchTool(name, args);
          } catch (err) {
            result = { error: err.message };
          }

          if (verbose) this._log(`   Result: ${JSON.stringify(result, null, 2)}`);
          else this._log(`   ✓ Done (${Object.keys(result).length} fields)`);

          toolResponses.push({
            functionResponse: {
              name,
              response: { content: result },
            },
          });
        }

        // Send all tool results back in one turn
        response = await chat.sendMessage(toolResponses);
        continue;
      }

      // ── Case 2: Gemini finished reasoning ────────────────────────
      if (textParts.length > 0) {
        finalText = textParts.map((p) => p.text).join("");
        this._log(`\n✅  Agent finished after ${iterations} iteration(s)`);
        break;
      }

      // ── Case 3: Finish reason other than normal ───────────────────
      const finishReason = candidate.finishReason;
      this._log(`⚠️  Finish reason: ${finishReason}`);
      break;
    }

    if (!finalText) {
      return this._fallbackResult(homeTeam, awayTeam);
    }

    return this._parseGeminiOutput(finalText, homeTeam, awayTeam);
  }

  // ════════════════════════════════════════════════════════════════════
  //  TOOL DISPATCHER
  // ════════════════════════════════════════════════════════════════════

  async _dispatchTool(name, args) {
    switch (name) {
      case "get_team_form":
        return this._getTeamForm(
          args.team_name,
          args.num_matches || this.config.formMatchLimit
        );
      case "get_head_to_head":
        return this._getHeadToHead(args.team1, args.team2);
      case "get_league_standings":
        return this._getLeagueStandings(args.competition_code);
      case "search_team_news":
        return this._searchTeamNews(args.query);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  TOOL IMPLEMENTATIONS
  // ════════════════════════════════════════════════════════════════════

  async _getTeamForm(teamName, numMatches = 6) {
    const cacheKey = `form:${teamName}:${numMatches}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    const teamId = await this._findTeamId(teamName);
    if (!teamId) {
      this._log(`   ⚠️  Team not found: ${teamName}, using mock`);
      return this._mockForm(teamName, numMatches);
    }

    const resp = await axios.get(
      `${this.apiBase}/teams/${teamId}/matches?limit=20&status=FINISHED`,
      { headers: this.footballHeaders, timeout: 8000 }
    );

    const matches = (resp.data.matches || []).slice(0, numMatches);
    if (matches.length === 0) return this._mockForm(teamName, numMatches);

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

    // Recency-weighted form score (newest = highest weight)
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
      isMock: false,
    };

    this._setCache(cacheKey, result);
    return result;
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

    let t1Wins = 0, t2Wins = 0, draws = 0;
    let t1Goals = 0, t2Goals = 0;
    let weightedDom = 0;
    const recent = [];
    const total = h2hMatches.length;

    h2hMatches.forEach((m, i) => {
      const isT1Home = m.homeTeam.id === team1Id;
      const t1Score = isT1Home ? m.score.fullTime.home : m.score.fullTime.away;
      const t2Score = isT1Home ? m.score.fullTime.away : m.score.fullTime.home;
      const recencyW = total - i; // newest = highest weight

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
          winner:
            m.score.fullTime.home > m.score.fullTime.away ? m.homeTeam.name :
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
      dominanceScore: +dominanceScore.toFixed(1), // >50 favors team1
      advantage: t1Wins > t2Wins ? team1Name : t2Wins > t1Wins ? team2Name : "Balanced",
      recentMeetings: recent,
      reliability: total >= 5 ? "high" : "medium",
      isMock: false,
    };

    this._setCache(cacheKey, result);
    return result;
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
        note: "Set NEWS_API_KEY env var for live injury/news data (free at newsapi.org)",
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
  //  TEAM ID RESOLUTION
  // ════════════════════════════════════════════════════════════════════

  async _findTeamId(teamName) {
    if (!teamName || typeof teamName !== "string") return null;
    teamName = teamName.trim();

    if (this.teamCache.has(teamName)) return this.teamCache.get(teamName);

    // Strategy 1: name search endpoint
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

    // Strategy 2: full list fuzzy match
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
  //  OUTPUT PARSING
  // ════════════════════════════════════════════════════════════════════

  _parseGeminiOutput(text, homeTeam, awayTeam) {
    // Extract JSON block between ```json ... ``` or raw { ... }
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

    // Could not parse JSON — return raw text for debugging
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
  //  PROMPTS
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
  //  CACHE HELPERS
  // ════════════════════════════════════════════════════════════════════

  _getCache(key) {
    const entry = this.resultCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.resultCache.delete(key); return null; }
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
  //  MOCK FALLBACKS  (when API unavailable)
  // ════════════════════════════════════════════════════════════════════

  _mockForm(teamName, n) {
    const results = ["W", "W", "D", "L", "W", "D"];
    let formString = "";
    const form = [];
    for (let i = 0; i < n; i++) {
      const r = results[i % results.length];
      formString += r;
      form.push({ matchday: i + 1, opponent: "Unknown FC", venue: "H", result: r, score: "1-1", date: "N/A", goalDiff: 0 });
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
      _meta: { generatedAt: new Date().toISOString(), model: this.model, fallback: true },
    };
  }

  _log(msg) {
    console.log(msg);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  USAGE
// ══════════════════════════════════════════════════════════════════════

async function main() {
  const agent = new AIMatchAgent({
    geminiApiKey:    process.env.GEMINI_API_KEY,
    footballApiKey:  process.env.FOOTBALL_API_KEY,
    newsApiKey:      process.env.NEWS_API_KEY || null,   // optional
  });

  const result = await agent.predict("Manchester City", "Arsenal", {
    competition: "Premier League",
    verbose: false,
  });

  console.log("\n\n══════ PREDICTION RESULT ══════");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);

module.exports = AIMatchAgent;