/**
 * AI Match Analysis Agent — Single-Call Edition
 * UPDATED: Fetches from historical_matches and worldcup_matches tables
 * Architecture:
 *   Step 1 — Try historical database first, then API, then mock
 *   Step 2 — ONE Gemini call with all data pre-loaded
 */

"use strict";

const axios  = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

class AIMatchAgent {
  constructor({ footballApiKey, geminiApiKey, newsApiKey = null, databaseUrl = null }) {
    this.genAI          = new GoogleGenerativeAI(geminiApiKey);
    this.footballApiKey = footballApiKey;
    this.newsApiKey     = newsApiKey;

    this.apiBase         = "https://api.football-data.org/v4";
    this.footballHeaders = { "X-Auth-Token": this.footballApiKey };

    // Database connection (optional)
    this.pool = null;
    if (databaseUrl) {
      const { Pool } = require('pg');
      this.pool = new Pool({ 
        connectionString: databaseUrl, 
        ssl: { rejectUnauthorized: false } 
      });
      this._log("✅ AI Agent connected to database");
    }

    this.teamCache   = new Map();
    this.resultCache = new Map();
    this.CACHE_TTL   = 15 * 60 * 1000; // 15 min

    // List of valid World Cup teams (expand as needed)
    this.wcTeams = new Set([
      'Brazil', 'Argentina', 'France', 'Germany', 'Spain', 'Portugal', 'England',
      'Netherlands', 'Belgium', 'Croatia', 'Switzerland', 'Uruguay', 'Colombia',
      'Japan', 'South Korea', 'Morocco', 'Senegal', 'USA', 'Mexico', 'Canada',
      'Poland', 'Denmark', 'Sweden', 'Norway', 'Wales', 'Scotland', 'Australia',
      'Iran', 'Saudi Arabia', 'Qatar', 'Tunisia', 'Algeria', 'Nigeria', 'Ghana',
      'Cameroon', 'Ivory Coast', 'Ecuador', 'Peru', 'Chile', 'Paraguay', 'Bolivia',
      'Venezuela', 'Costa Rica', 'Panama', 'Jamaica', 'Honduras', 'South Africa',
      'Egypt', 'Morocco', 'Senegal', 'Tunisia', 'Algeria', 'Nigeria', 'Cape Verde Islands',
      'Uzbekistan', 'Jordan', 'Austria', 'Haiti', 'Scotland', 'New Zealand', 'Curaçao',
      'Croatia', 'Switzerland', 'Poland', 'Denmark', 'Sweden', 'Norway', 'Wales',
      'Scotland', 'Australia', 'Iran', 'Saudi Arabia', 'Qatar', 'Tunisia', 'Algeria',
      'Nigeria', 'Ghana', 'Cameroon', 'Ivory Coast', 'Ecuador', 'Peru', 'Chile',
      'Paraguay', 'Bolivia', 'Venezuela', 'Costa Rica', 'Panama', 'Jamaica', 'Honduras',
      'South Africa', 'Egypt', 'Morocco', 'Senegal'
    ]);

    this.model  = "gemini-2.5-flash";
    this.config = {
      formMatchLimit  : 6,
      h2hMatchLimit   : 8,
      minH2HThreshold : 3,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PUBLIC — predict()  (1 Gemini call total)
  // ══════════════════════════════════════════════════════════════════════

  async predict(homeTeam, awayTeam, options = {}) {
    const { competition = "Unknown", verbose = false } = options;

    this._log(`\n${"=".repeat(60)}`);
    this._log(`SINGLE-CALL AGENT: ${homeTeam}  vs  ${awayTeam}`);
    this._log(`${"=".repeat(60)}`);

    // Step 1 — fetch all data in parallel (try DB first, then API)
    this._log("\n[1/2] Fetching all data in parallel...");
    const t0 = Date.now();

    const [homeFormResult, awayFormResult, h2hResult, newsResult] =
      await Promise.allSettled([
        this._getTeamForm(homeTeam, this.config.formMatchLimit),
        this._getTeamForm(awayTeam, this.config.formMatchLimit),
        this._getHeadToHead(homeTeam, awayTeam),
        this._searchTeamNews(`${homeTeam} ${awayTeam} injury suspension lineup 2025`),
      ]);

    const data = {
      homeForm : homeFormResult.status === "fulfilled" ? homeFormResult.value : this._mockForm(homeTeam, this.config.formMatchLimit),
      awayForm : awayFormResult.status === "fulfilled" ? awayFormResult.value : this._mockForm(awayTeam, this.config.formMatchLimit),
      h2h      : h2hResult.status      === "fulfilled" ? h2hResult.value      : this._mockH2H(homeTeam, awayTeam),
      news     : newsResult.status     === "fulfilled" ? newsResult.value      : { articles: [] },
    };

    this._log(`    Done in ${Date.now() - t0}ms`);
    this._log(`    Home form  : ${data.homeForm.formString}  mock=${data.homeForm.isMock}`);
    this._log(`    Away form  : ${data.awayForm.formString}  mock=${data.awayForm.isMock}`);
    this._log(`    H2H        : ${data.h2h.totalMatches} matches  mock=${data.h2h.isMock}`);
    this._log(`    News items : ${data.news.articles.length}`);

    // Step 2 — ONE Gemini call
    this._log("\n[2/2] Calling Gemini (1 API call)...");
    const t1 = Date.now();

    const prompt = this._buildPrompt(homeTeam, awayTeam, competition, data);
    if (verbose) this._log(`    Prompt: ${prompt.length} chars`);

    let rawText;
    try {
      const model  = this.genAI.getGenerativeModel({ model: this.model });
      const result = await model.generateContent(prompt);
      rawText      = result.response.text();
    } catch (err) {
      this._log(`    Gemini error: ${err.message}`);
      return this._fallbackResult(homeTeam, awayTeam, err.message);
    }

    this._log(`    Gemini done in ${Date.now() - t1}ms`);
    if (verbose) this._log(`\nRaw:\n${rawText}`);

    const parsed = this._parseOutput(rawText, homeTeam, awayTeam);
    parsed._meta = {
      homeTeam, awayTeam, competition,
      generatedAt  : new Date().toISOString(),
      model        : this.model,
      geminiCalls  : 1,
      dataQuality  : this._dataQuality(data),
      dataSources  : {
        homeFormMock : data.homeForm.isMock,
        awayFormMock : data.awayForm.isMock,
        h2hMock      : data.h2h.isMock,
        newsArticles : data.news.articles.length,
      },
    };

    this._log(`\nDone — 1 Gemini call used`);
    return parsed;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  DATABASE-FIRST IMPLEMENTATIONS - UPDATED for historical_matches
  // ══════════════════════════════════════════════════════════════════════

  async _getTeamFormFromDB(teamName, numMatches = 6) {
    if (!this.pool) return null;

    try {
      // Query from historical_matches table (2010-2022 international matches)
      const result = await this.pool.query(
        `SELECT * FROM historical_matches 
         WHERE (home_team = $1 OR away_team = $1)
         ORDER BY match_date DESC 
         LIMIT $2`,
        [teamName, numMatches]
      );

      if (result.rows.length === 0) {
        // If no historical matches, try worldcup_matches for any finished WC games
        const wcResult = await this.pool.query(
          `SELECT * FROM worldcup_matches 
           WHERE (home_team = $1 OR away_team = $1)
           AND status = 'FINISHED'
           ORDER BY start_time DESC 
           LIMIT $2`,
          [teamName, numMatches]
        );
        
        if (wcResult.rows.length === 0) return null;
        
        // Convert worldcup_matches format to historical format
        return this._convertWCMatchesToForm(wcResult.rows, teamName);
      }

      const matches = result.rows;
      let form = [];
      let goalsFor = 0, goalsAgainst = 0;
      let wins = 0, draws = 0, losses = 0;

      for (const match of matches) {
        const isHome = match.home_team === teamName;
        const teamScore = isHome ? match.home_score : match.away_score;
        const oppScore = isHome ? match.away_score : match.home_score;
        
        goalsFor += teamScore;
        goalsAgainst += oppScore;

        let result = 'D';
        if (teamScore > oppScore) {
          result = 'W';
          wins++;
        } else if (teamScore < oppScore) {
          result = 'L';
          losses++;
        } else {
          draws++;
        }

        form.push({
          matchday: form.length + 1,
          opponent: isHome ? match.away_team : match.home_team,
          venue: isHome ? "H" : "A",
          result,
          score: `${teamScore}-${oppScore}`,
          date: new Date(match.match_date * 1000).toISOString().split('T')[0],
          goalDiff: teamScore - oppScore,
          competition: match.competition,
          season: match.season
        });
      }

      const n = matches.length;
      const formString = form.map(f => f.result).join('');
      
      // Calculate weighted form score (more recent = higher weight)
      let wPts = 0, wTotal = 0;
      form.forEach((f, i) => {
        const w = n - i; // Most recent (i=0) gets highest weight
        wTotal += w * 3;
        if (f.result === "W") wPts += w * 3;
        else if (f.result === "D") wPts += w;
      });
      const formScore = wTotal > 0 ? (wPts / wTotal) * 100 : 50;

      const last3 = form.slice(0, 3).map(f => f.result);
      const momentum =
        last3.filter(r => r === "W").length >= 2 ? "positive" :
        last3.filter(r => r === "L").length >= 2 ? "negative" : "neutral";

      // Calculate clean sheets
      const cleanSheets = form.filter(f => {
        const [home, away] = f.score.split('-').map(Number);
        return f.result === 'W' && (f.venue === "H" ? away === 0 : home === 0);
      }).length;

      return {
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
        source: 'historical_db',
        isMock: false,
      };
    } catch (err) {
      this._log(`    DB form error: ${err.message}`);
      return null;
    }
  }

  async _convertWCMatchesToForm(matches, teamName) {
    let form = [];
    let goalsFor = 0, goalsAgainst = 0;
    let wins = 0, draws = 0, losses = 0;

    for (const match of matches) {
      const isHome = match.home_team === teamName;
      const teamScore = isHome ? match.home_score : match.away_score;
      const oppScore = isHome ? match.away_score : match.home_score;
      
      goalsFor += teamScore;
      goalsAgainst += oppScore;

      let result = 'D';
      if (teamScore > oppScore) {
        result = 'W';
        wins++;
      } else if (teamScore < oppScore) {
        result = 'L';
        losses++;
      } else {
        draws++;
      }

      form.push({
        matchday: form.length + 1,
        opponent: isHome ? match.away_team : match.home_team,
        venue: isHome ? "H" : "A",
        result,
        score: `${teamScore}-${oppScore}`,
        date: new Date(match.start_time * 1000).toISOString().split('T')[0],
        goalDiff: teamScore - oppScore,
        competition: 'FIFA World Cup',
        season: '2026'
      });
    }

    const n = matches.length;
    const formString = form.map(f => f.result).join('');
    
    let wPts = 0, wTotal = 0;
    form.forEach((f, i) => {
      const w = n - i;
      wTotal += w * 3;
      if (f.result === "W") wPts += w * 3;
      else if (f.result === "D") wPts += w;
    });
    const formScore = wTotal > 0 ? (wPts / wTotal) * 100 : 50;

    const last3 = form.slice(0, 3).map(f => f.result);
    const momentum =
      last3.filter(r => r === "W").length >= 2 ? "positive" :
      last3.filter(r => r === "L").length >= 2 ? "negative" : "neutral";

    const cleanSheets = form.filter(f => {
      const [home, away] = f.score.split('-').map(Number);
      return f.result === 'W' && (f.venue === "H" ? away === 0 : home === 0);
    }).length;

    return {
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
      source: 'worldcup_db',
      isMock: false,
    };
  }

  async _getH2HFromDB(team1, team2) {
    if (!this.pool) return null;

    try {
      // Query from historical_matches table first
      const result = await this.pool.query(
        `SELECT * FROM historical_matches 
         WHERE (home_team = $1 AND away_team = $2) 
            OR (home_team = $2 AND away_team = $1)
         ORDER BY match_date DESC`,
        [team1, team2]
      );

      if (result.rows.length < 2) {
        // Try worldcup_matches for any WC meetings
        const wcResult = await this.pool.query(
          `SELECT * FROM worldcup_matches 
           WHERE ((home_team = $1 AND away_team = $2) 
              OR (home_team = $2 AND away_team = $1))
           AND status = 'FINISHED'
           ORDER BY start_time DESC`,
          [team1, team2]
        );
        
        if (wcResult.rows.length === 0) return null;
        
        // Convert WC matches format
        return this._convertWCMatchesToH2H(wcResult.rows, team1, team2);
      }

      const matches = result.rows;
      let team1Wins = 0, team2Wins = 0, draws = 0;
      let team1Goals = 0, team2Goals = 0;
      let weightedDom = 0;
      const recent = [];
      const total = matches.length;

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const isTeam1Home = match.home_team === team1;
        const t1Score = isTeam1Home ? match.home_score : match.away_score;
        const t2Score = isTeam1Home ? match.away_score : match.home_score;
        const recencyW = total - i; // More recent = higher weight

        team1Goals += t1Score;
        team2Goals += t2Score;

        if (t1Score > t2Score) { 
          team1Wins++; 
          weightedDom += recencyW;
        } else if (t1Score < t2Score) { 
          team2Wins++; 
          weightedDom -= recencyW;
        } else { 
          draws++; 
        }

        if (i < 5) {
          recent.push({
            date: new Date(match.match_date * 1000).toISOString().split('T')[0],
            home: match.home_team,
            away: match.away_team,
            score: `${match.home_score}-${match.away_score}`,
            winner: match.winner || (match.home_score > match.away_score ? match.home_team :
                    match.home_score < match.away_score ? match.away_team : "Draw"),
            competition: match.competition,
            season: match.season
          });
        }
      }

      const maxWeight = (total * (total + 1)) / 2;
      const dominanceScore = 50 + (weightedDom / maxWeight) * 50;

      return {
        teams: { team1, team2 },
        totalMatches: total,
        record: { team1Wins, team2Wins, draws },
        rates: {
          team1WinRate: +((team1Wins / total) * 100).toFixed(1),
          team2WinRate: +((team2Wins / total) * 100).toFixed(1),
          drawRate: +((draws / total) * 100).toFixed(1),
        },
        goals: {
          team1Total: team1Goals,
          team2Total: team2Goals,
          avgPerMatch: +((team1Goals + team2Goals) / total).toFixed(2),
        },
        dominanceScore: +dominanceScore.toFixed(1),
        advantage: team1Wins > team2Wins ? team1 : team2Wins > team1Wins ? team2 : "Balanced",
        recentMeetings: recent,
        reliability: total >= 5 ? "high" : "medium",
        source: 'historical_db',
        isMock: false,
      };
    } catch (err) {
      this._log(`    DB H2H error: ${err.message}`);
      return null;
    }
  }

  async _convertWCMatchesToH2H(matches, team1, team2) {
    let team1Wins = 0, team2Wins = 0, draws = 0;
    let team1Goals = 0, team2Goals = 0;
    let weightedDom = 0;
    const recent = [];
    const total = matches.length;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const isTeam1Home = match.home_team === team1;
      const t1Score = isTeam1Home ? match.home_score : match.away_score;
      const t2Score = isTeam1Home ? match.away_score : match.home_score;
      const recencyW = total - i;

      team1Goals += t1Score;
      team2Goals += t2Score;

      if (t1Score > t2Score) { 
        team1Wins++; 
        weightedDom += recencyW;
      } else if (t1Score < t2Score) { 
        team2Wins++; 
        weightedDom -= recencyW;
      } else { 
        draws++; 
      }

      if (i < 5) {
        recent.push({
          date: new Date(match.start_time * 1000).toISOString().split('T')[0],
          home: match.home_team,
          away: match.away_team,
          score: `${match.home_score}-${match.away_score}`,
          winner: match.winner,
          competition: 'FIFA World Cup',
          season: '2026'
        });
      }
    }

    const maxWeight = (total * (total + 1)) / 2;
    const dominanceScore = 50 + (weightedDom / maxWeight) * 50;

    return {
      teams: { team1, team2 },
      totalMatches: total,
      record: { team1Wins, team2Wins, draws },
      rates: {
        team1WinRate: +((team1Wins / total) * 100).toFixed(1),
        team2WinRate: +((team2Wins / total) * 100).toFixed(1),
        drawRate: +((draws / total) * 100).toFixed(1),
      },
      goals: {
        team1Total: team1Goals,
        team2Total: team2Goals,
        avgPerMatch: +((team1Goals + team2Goals) / total).toFixed(2),
      },
      dominanceScore: +dominanceScore.toFixed(1),
      advantage: team1Wins > team2Wins ? team1 : team2Wins > team1Wins ? team2 : "Balanced",
      recentMeetings: recent,
      reliability: total >= 5 ? "high" : "medium",
      source: 'worldcup_db',
      isMock: false,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ENHANCED TEAM ID RESOLUTION (prioritizes national teams)
  // ══════════════════════════════════════════════════════════════════════

  async _findTeamId(teamName) {
    if (!teamName || typeof teamName !== "string") return null;
    teamName = teamName.trim();
    
    // Check cache first
    if (this.teamCache.has(teamName)) return this.teamCache.get(teamName);

    // For World Cup matches, we want NATIONAL TEAMS
    const isWCTeam = this.wcTeams.has(teamName);

    // Strategy 1: Try with competition filter - get teams from WC (most reliable for national teams)
    if (isWCTeam) {
      try {
        const wcResp = await axios.get(
          `${this.apiBase}/competitions/WC/teams`,
          { headers: this.footballHeaders, timeout: 5000 }
        );
        
        const nationalTeam = wcResp.data.teams?.find(t => 
          t.name.toLowerCase() === teamName.toLowerCase() ||
          t.shortName?.toLowerCase() === teamName.toLowerCase() ||
          t.tla?.toLowerCase() === teamName.toLowerCase()
        );
        
        if (nationalTeam) {
          this.teamCache.set(teamName, nationalTeam.id);
          this._log(`    Found national team: ${teamName} (ID: ${nationalTeam.id})`);
          return nationalTeam.id;
        }
      } catch (err) {
        this._log(`    WC teams fetch failed: ${err.message}`);
      }
    }

    // Strategy 2: Try name search with area filter (prefer national teams)
    try {
      const resp = await axios.get(
        `${this.apiBase}/teams?name=${encodeURIComponent(teamName)}`,
        { headers: this.footballHeaders, timeout: 5000 }
      );
      
      if (resp.data.teams?.length > 0) {
        // For World Cup teams, try to find the national team version
        if (isWCTeam) {
          const nationalTeam = resp.data.teams.find(t => 
            t.area?.name === teamName || t.type === "NATIONAL"
          );
          if (nationalTeam) {
            this.teamCache.set(teamName, nationalTeam.id);
            return nationalTeam.id;
          }
        }
        
        // Otherwise take the first result
        this.teamCache.set(teamName, resp.data.teams[0].id);
        return resp.data.teams[0].id;
      }
    } catch { }

    // Strategy 3: Full list fuzzy match
    try {
      const resp  = await axios.get(`${this.apiBase}/teams?limit=200`, { headers: this.footballHeaders, timeout: 8000 });
      const lower = teamName.toLowerCase();
      const teams = resp.data.teams || [];
      
      // First try to find a national team match
      if (isWCTeam) {
        const nationalTeam = teams.find(t => 
          (t.area?.name?.toLowerCase() === lower || t.type === "NATIONAL") &&
          (t.name?.toLowerCase().includes(lower) || t.shortName?.toLowerCase().includes(lower))
        );
        if (nationalTeam) {
          this.teamCache.set(teamName, nationalTeam.id);
          return nationalTeam.id;
        }
      }
      
      // Fallback to any match
      const team = teams.find(t =>
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
    } catch { }

    return null;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MODIFIED DATA FETCHERS (try DB first, then API)
  // ══════════════════════════════════════════════════════════════════════

  async _getTeamForm(teamName, numMatches = 6) {
    const cacheKey = `form:${teamName}:${numMatches}`;
    const cached = this._getCache(cacheKey);
    if (cached) { 
      this._log(`    Cache hit: form ${teamName}`); 
      return cached; 
    }

    // Try database first (historical_matches)
    if (this.pool) {
      const dbForm = await this._getTeamFormFromDB(teamName, numMatches);
      if (dbForm) {
        this._setCache(cacheKey, dbForm);
        return dbForm;
      }
    }

    // Fall back to API
    const teamId = await this._findTeamId(teamName);
    if (!teamId) return this._mockForm(teamName, numMatches);

    try {
      const resp = await axios.get(
        `${this.apiBase}/teams/${teamId}/matches?limit=20&status=FINISHED`,
        { headers: this.footballHeaders, timeout: 8000 }
      );

      const matches = (resp.data.matches || []).slice(0, numMatches);
      if (!matches.length) return this._mockForm(teamName, numMatches);

      let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0, cs = 0;
      const form = [];

      matches.forEach((m, i) => {
        const isHome   = m.homeTeam.id === teamId;
        const scored   = isHome ? m.score.fullTime.home : m.score.fullTime.away;
        const conceded = isHome ? m.score.fullTime.away : m.score.fullTime.home;
        gf += scored; ga += conceded;
        if (conceded === 0) cs++;
        let result;
        if      (scored > conceded) { result = "W"; wins++;   }
        else if (scored < conceded) { result = "L"; losses++; }
        else                        { result = "D"; draws++;  }
        form.push({
          matchday: i + 1,
          opponent: isHome ? m.awayTeam.name : m.homeTeam.name,
          venue   : isHome ? "H" : "A",
          result, score: `${scored}-${conceded}`,
          date    : m.utcDate.split("T")[0],
          goalDiff: scored - conceded,
        });
      });

      const n = matches.length;
      const formString = form.map(f => f.result).join("");
      let wPts = 0, wTotal = 0;
      form.forEach((f, i) => {
        const w = n - i;
        wTotal += w * 3;
        if (f.result === "W") wPts += w * 3;
        else if (f.result === "D") wPts += w;
      });
      const formScore = wTotal > 0 ? (wPts / wTotal) * 100 : 50;
      const last3 = form.slice(0, 3).map(f => f.result);
      const momentum =
        last3.filter(r => r === "W").length >= 2 ? "positive" :
        last3.filter(r => r === "L").length >= 2 ? "negative" : "neutral";

      const result = {
        team: teamName, 
        formString,
        formScore: +formScore.toFixed(1),
        record: { wins, draws, losses, points: wins * 3 + draws, maxPoints: n * 3 },
        goals: {
          scored: gf, 
          conceded: ga,
          avgScored: +(gf / n).toFixed(2),
          avgConceded: +(ga / n).toFixed(2),
          cleanSheets: cs,
          cleanSheetRate: +((cs / n) * 100).toFixed(1),
        },
        momentum, 
        recentMatches: form, 
        source: 'api',
        isMock: false,
      };
      this._setCache(cacheKey, result);
      return result;
    } catch (error) {
      this._log(`    API error for ${teamName}, using mock`);
      return this._mockForm(teamName, numMatches);
    }
  }

  async _getHeadToHead(team1Name, team2Name) {
    const cacheKey = `h2h:${team1Name}:${team2Name}`;
    const cached = this._getCache(cacheKey);
    if (cached) { 
      this._log(`    Cache hit: h2h`); 
      return cached; 
    }

    // Try database first (historical_matches)
    if (this.pool) {
      const dbH2H = await this._getH2HFromDB(team1Name, team2Name);
      if (dbH2H) {
        this._setCache(cacheKey, dbH2H);
        return dbH2H;
      }
    }

    // Fall back to API
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
        .filter(m => m.homeTeam.id === team2Id || m.awayTeam.id === team2Id)
        .slice(0, this.config.h2hMatchLimit);

      if (h2hMatches.length < this.config.minH2HThreshold)
        return { ...this._mockH2H(team1Name, team2Name), note: "Insufficient H2H data" };

      let t1W = 0, t2W = 0, draws = 0, t1G = 0, t2G = 0, wDom = 0;
      const recent = [];
      const total  = h2hMatches.length;

      h2hMatches.forEach((m, i) => {
        const isT1Home = m.homeTeam.id === team1Id;
        const t1S = isT1Home ? m.score.fullTime.home : m.score.fullTime.away;
        const t2S = isT1Home ? m.score.fullTime.away : m.score.fullTime.home;
        const rW  = total - i;
        t1G += t1S; t2G += t2S;
        if      (t1S > t2S) { t1W++; wDom += rW; }
        else if (t1S < t2S) { t2W++; wDom -= rW; }
        else                { draws++; }
        if (i < 5) recent.push({
          date  : m.utcDate.split("T")[0],
          home  : m.homeTeam.name, 
          away: m.awayTeam.name,
          score : `${m.score.fullTime.home}-${m.score.fullTime.away}`,
          winner:
            m.score.fullTime.home > m.score.fullTime.away ? m.homeTeam.name :
            m.score.fullTime.home < m.score.fullTime.away ? m.awayTeam.name : "Draw",
        });
      });

      const maxW = (total * (total + 1)) / 2;
      const dom  = 50 + (wDom / maxW) * 50;
      const result = {
        teams: { team1: team1Name, team2: team2Name }, 
        totalMatches: total,
        record: { team1Wins: t1W, team2Wins: t2W, draws },
        rates: {
          team1WinRate: +((t1W / total) * 100).toFixed(1),
          team2WinRate: +((t2W / total) * 100).toFixed(1),
          drawRate    : +((draws / total) * 100).toFixed(1),
        },
        goals: { 
          team1Total: t1G, 
          team2Total: t2G, 
          avgPerMatch: +((t1G + t2G) / total).toFixed(2) 
        },
        dominanceScore: +dom.toFixed(1),
        advantage: t1W > t2W ? team1Name : t2W > t1W ? team2Name : "Balanced",
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

  async _searchTeamNews(query) {
    if (!this.newsApiKey) return { query, articles: [], note: "Set NEWS_API_KEY for live news" };
    try {
      const resp = await axios.get(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${this.newsApiKey}`,
        { timeout: 6000 }
      );
      const articles = (resp.data.articles || []).map(a => ({
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

  // ══════════════════════════════════════════════════════════════════════
  //  PROMPT BUILDER
  // ══════════════════════════════════════════════════════════════════════

  _buildPrompt(homeTeam, awayTeam, competition, data) {
    const { homeForm, awayForm, h2h, news } = data;

    const newsBlock = news.articles.length > 0
      ? news.articles.slice(0, 5)
          .map(a => `  - [${a.publishedAt || "recent"}] ${a.title} (${a.source || "unknown"})`)
          .join("\n")
      : "  No recent news available.";

    const recentH2H = h2h.recentMeetings?.length
      ? h2h.recentMeetings.slice(0, 5)
          .map(m => `  ${m.date}  ${m.home} ${m.score} ${m.away}  -> ${m.winner}`)
          .join("\n")
      : "  No recent meetings on record.";

    const homeMatches = homeForm.recentMatches?.length
      ? homeForm.recentMatches.slice(0, 6)
          .map(m => `  ${m.date}  ${m.venue === "H" ? "HOME" : "AWAY"}  vs ${m.opponent}  ${m.score}  [${m.result}]`)
          .join("\n")
      : "  No recent matches.";

    const awayMatches = awayForm.recentMatches?.length
      ? awayForm.recentMatches.slice(0, 6)
          .map(m => `  ${m.date}  ${m.venue === "H" ? "HOME" : "AWAY"}  vs ${m.opponent}  ${m.score}  [${m.result}]`)
          .join("\n")
      : "  No recent matches.";

    return `You are an elite football analyst and sports betting specialist.
All data has already been gathered. Reason over it and produce a sharp prediction.
Do NOT ask for more data.

================================================================
MATCH: ${homeTeam}  vs  ${awayTeam}
COMPETITION: ${competition}
================================================================

--- HOME TEAM: ${homeTeam} ---
Form string     : ${homeForm.formString || "N/A"}  (left = most recent)
Form score      : ${homeForm.formScore ?? "N/A"} / 100
Record (last ${this.config.formMatchLimit})  : W${homeForm.record?.wins ?? 0} D${homeForm.record?.draws ?? 0} L${homeForm.record?.losses ?? 0}  (${homeForm.record?.points ?? 0} pts)
Avg goals scored: ${homeForm.goals?.avgScored ?? "N/A"}
Avg goals conceded: ${homeForm.goals?.avgConceded ?? "N/A"}
Clean sheet rate: ${homeForm.goals?.cleanSheetRate ?? "N/A"}%
Momentum        : ${homeForm.momentum ?? "N/A"}
Data source     : ${homeForm.source || (homeForm.isMock ? "ESTIMATED (fallback)" : "Historical database")}

Recent matches:
${homeMatches}

--- AWAY TEAM: ${awayTeam} ---
Form string     : ${awayForm.formString || "N/A"}  (left = most recent)
Form score      : ${awayForm.formScore ?? "N/A"} / 100
Record (last ${this.config.formMatchLimit})  : W${awayForm.record?.wins ?? 0} D${awayForm.record?.draws ?? 0} L${awayForm.record?.losses ?? 0}  (${awayForm.record?.points ?? 0} pts)
Avg goals scored: ${awayForm.goals?.avgScored ?? "N/A"}
Avg goals conceded: ${awayForm.goals?.avgConceded ?? "N/A"}
Clean sheet rate: ${awayForm.goals?.cleanSheetRate ?? "N/A"}%
Momentum        : ${awayForm.momentum ?? "N/A"}
Data source     : ${awayForm.source || (awayForm.isMock ? "ESTIMATED (fallback)" : "Historical database")}

Recent matches:
${awayMatches}

--- HEAD TO HEAD (last ${h2h.totalMatches} meetings) ---
${homeTeam} wins : ${h2h.record?.team1Wins ?? 0}  (${h2h.rates?.team1WinRate ?? 0}%)
${awayTeam} wins : ${h2h.record?.team2Wins ?? 0}  (${h2h.rates?.team2WinRate ?? 0}%)
Draws            : ${h2h.record?.draws ?? 0}  (${h2h.rates?.drawRate ?? 0}%)
Avg goals/match  : ${h2h.goals?.avgPerMatch ?? "N/A"}
Dominance score  : ${h2h.dominanceScore ?? 50} / 100  (>50 favours ${homeTeam})
Historical edge  : ${h2h.advantage ?? "Balanced"}
Data reliability : ${h2h.reliability ?? "low"}
Data source      : ${h2h.source || (h2h.isMock ? "ESTIMATED (fallback)" : "Historical database")}

Recent meetings:
${recentH2H}

--- LATEST NEWS & TEAM UPDATES ---
${newsBlock}

================================================================
INSTRUCTIONS
================================================================
Analyse ALL the data above and return ONLY the JSON block below.
No prose. No explanation. Just the JSON.

Rules:
- prediction.homeWin + prediction.draw + prediction.awayWin MUST equal exactly 100.
- Apply a 1.15-1.25x home advantage factor to raw form scores.
- If data source says ESTIMATED, lower your confidence.
- Be sharp and realistic.

\`\`\`json
{
  "homeTeam": "${homeTeam}",
  "awayTeam": "${awayTeam}",
  "competition": "${competition}",
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
    "avoidBets": ["string"]
  },
  "keyFactors": ["string", "string", "string"],
  "riskFactors": ["string"],
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
  "warningFlags": ["string"]
}
\`\`\``;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════════════════════════════

  _parseOutput(text, homeTeam, awayTeam) {
    const m = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/);
    if (m) { 
      try { 
        return JSON.parse(m[1]); 
      } catch { } 
    }
    return { 
      homeTeam, 
      awayTeam, 
      rawAnalysis: text,
      prediction: { homeWin: null, draw: null, awayWin: null },
      mostLikely: "UNKNOWN", 
      confidence: "LOW", 
      _parseError: true 
    };
  }

  _dataQuality({ homeForm, awayForm, h2h }) {
    const score = [!homeForm.isMock, !awayForm.isMock, !h2h.isMock].filter(Boolean).length;
    return score === 3 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
  }

  _getCache(key) {
    const e = this.resultCache.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { 
      this.resultCache.delete(key); 
      return null; 
    }
    return e.data;
  }

  _setCache(key, data) {
    this.resultCache.set(key, { data, expiresAt: Date.now() + this.CACHE_TTL });
  }

  clearCaches() { 
    this.teamCache.clear(); 
    this.resultCache.clear(); 
    this._log("✓ Caches cleared"); 
  }

  _mockForm(teamName, n) {
    const seq = ["W","W","D","L","W","D"];
    let fs = "";
    const form = [];
    for (let i = 0; i < n; i++) {
      const r = seq[i % seq.length]; 
      fs += r;
      form.push({ 
        matchday: i+1, 
        opponent: "Unknown", 
        venue: "H", 
        result: r, 
        score: "1-1", 
        date: "N/A", 
        goalDiff: 0 
      });
    }
    const wins = (fs.match(/W/g)||[]).length, draws = (fs.match(/D/g)||[]).length;
    return { 
      team: teamName, 
      formString: fs, 
      formScore: +((wins*3+draws)/(n*3)*100).toFixed(1),
      record: { wins, draws, losses: n-wins-draws, points: wins*3+draws },
      goals: { 
        avgScored: 1.4, 
        avgConceded: 1.1, 
        cleanSheetRate: 20 
      },
      momentum: "neutral", 
      recentMatches: form, 
      source: 'mock',
      isMock: true 
    };
  }

  _mockH2H(t1, t2) {
    return { 
      teams: { team1: t1, team2: t2 }, 
      totalMatches: 5,
      record: { team1Wins: 2, team2Wins: 2, draws: 1 },
      rates: { 
        team1WinRate: 40, 
        team2WinRate: 40, 
        drawRate: 20 
      },
      goals: { avgPerMatch: 2.4 }, 
      dominanceScore: 50, 
      advantage: "Balanced",
      recentMeetings: [], 
      reliability: "low",
      source: 'mock', 
      isMock: true 
    };
  }

  _fallbackResult(homeTeam, awayTeam, errorMsg = "") {
    return { 
      homeTeam, 
      awayTeam,
      prediction: { homeWin: 40, draw: 25, awayWin: 35 },
      mostLikely: "HOME_WIN", 
      confidence: "LOW",
      bettingAngles: { 
        recommendedBet: "No bet — prediction failed", 
        btts: "UNCERTAIN" 
      },
      keyFactors: ["Prediction unavailable"], 
      dataQuality: "LOW",
      warningFlags: [errorMsg || "Gemini call failed"],
      _meta: { 
        generatedAt: new Date().toISOString(), 
        model: this.model, 
        fallback: true 
      } 
    };
  }

  _log(msg) { console.log(msg); }
}

module.exports = AIMatchAgent;