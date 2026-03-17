/**
 * AI Match Analysis Agent
 * Professional-grade football match predictor
 */

const axios = require('axios');

class AIAnalysisAgent {
  constructor(apiKey) {
    this.footballApiKey = apiKey;
    this.apiBase = "https://api.football-data.org/v4";
    this.headers = { "X-Auth-Token": this.footballApiKey };
    
    // Cache for team IDs to reduce API calls
    this.teamCache = new Map();
    
    // Configuration for predictions - easily tunable
    this.config = {
      homeAdvantage: 1.25,        // Home advantage multiplier
      weights: {
        form: 0.4,                 // Recent form weight
        h2h: 0.3,                  // Head-to-head weight
        recent: 0.3                 // Recent meetings weight
      },
      baseDrawProb: 24,             // Base draw probability (in %)
      minDataThreshold: 3,           // Minimum matches needed for reliable data
      formMatchLimit: 6,             // Number of recent matches to analyze
      h2hMatchLimit: 8               // Number of historical matches to analyze
    };
  }

  // ─── Validate Input ─────────────────────────────────────────────────
  validateTeamName(teamName) {
    if (!teamName || typeof teamName !== 'string') {
      throw new Error('Invalid team name');
    }
    return teamName.trim();
  }

  // ─── Find Team ID with Caching ──────────────────────────────────────
  async findTeamId(teamName) {
    try {
      teamName = this.validateTeamName(teamName);
      
      // Check cache first
      if (this.teamCache.has(teamName)) {
        console.log(`🔍 Cache hit for ${teamName}`);
        return this.teamCache.get(teamName);
      }
      
      console.log(`🔍 Searching for team: ${teamName}`);
      
      // Try exact match search first (more efficient)
      try {
        const searchResponse = await axios.get(
          `${this.apiBase}/teams?name=${encodeURIComponent(teamName)}`,
          { headers: this.headers, timeout: 5000 }
        );
        
        if (searchResponse.data.teams && searchResponse.data.teams.length > 0) {
          const team = searchResponse.data.teams[0];
          this.teamCache.set(teamName, team.id);
          return team.id;
        }
      } catch (e) {
        // Fall back to full list search
      }
      
      // Fallback: fetch full list and fuzzy match
      const response = await axios.get(
        `${this.apiBase}/teams?limit=200`,
        { headers: this.headers, timeout: 5000 }
      );
      
      const teams = response.data.teams || [];
      
      // Try multiple matching strategies
      const matchTeam = (team) => {
        const nameLower = teamName.toLowerCase();
        return (
          team.name?.toLowerCase() === nameLower ||
          team.shortName?.toLowerCase() === nameLower ||
          team.tla?.toLowerCase() === nameLower ||
          team.name?.toLowerCase().includes(nameLower) ||
          (team.shortName && team.shortName.toLowerCase().includes(nameLower))
        );
      };
      
      const team = teams.find(matchTeam);
      
      if (team) {
        this.teamCache.set(teamName, team.id);
        return team.id;
      }
      
      console.warn(`⚠️ Team not found: ${teamName}`);
      return null;
      
    } catch (error) {
      console.error(`Error finding team ${teamName}:`, error.message);
      return null;
    }
  }

  // ─── Fetch Head-to-Head History ──────────────────────────────────────
  async getHeadToHead(team1, team2) {
    try {
      team1 = this.validateTeamName(team1);
      team2 = this.validateTeamName(team2);
      
      console.log(`📊 Analyzing head-to-head: ${team1} vs ${team2}`);
      
      const team1Id = await this.findTeamId(team1);
      const team2Id = await this.findTeamId(team2);
      
      if (!team1Id || !team2Id) {
        return { 
          ...this.generateMockHeadToHead(team1, team2), 
          isMockData: true,
          reliability: 'low'
        };
      }
      
      const response = await axios.get(
        `${this.apiBase}/teams/${team1Id}/matches?limit=50&status=FINISHED`,
        { headers: this.headers, timeout: 8000 }
      );
      
      const h2hMatches = response.data.matches
        .filter(m => (m.homeTeam.id === team2Id || m.awayTeam.id === team2Id))
        .slice(0, this.config.h2hMatchLimit);
      
      if (h2hMatches.length < this.config.minDataThreshold) {
        return { 
          ...this.generateMockHeadToHead(team1, team2), 
          isMockData: true,
          reliability: 'low',
          message: 'Limited historical data'
        };
      }
      
      let team1Wins = 0, team2Wins = 0, draws = 0;
      let team1Goals = 0, team2Goals = 0;
      let team1HomeWins = 0, team1AwayWins = 0;
      let recentForm = [];
      
      h2hMatches.forEach((match, index) => {
        const isTeam1Home = match.homeTeam.id === team1Id;
        const team1Score = isTeam1Home ? match.score.fullTime.home : match.score.fullTime.away;
        const team2Score = isTeam1Home ? match.score.fullTime.away : match.score.fullTime.home;
        
        team1Goals += team1Score;
        team2Goals += team2Score;
        
        if (team1Score > team2Score) {
          team1Wins++;
          if (isTeam1Home) team1HomeWins++;
          else team1AwayWins++;
        } else if (team1Score < team2Score) {
          team2Wins++;
        } else {
          draws++;
        }
        
        // Track recent form (last 3 matches weighted more)
        if (index < 3) {
          recentForm.push({
            result: team1Score > team2Score ? 'W' : team1Score < team2Score ? 'L' : 'D',
            score: `${team1Score}-${team2Score}`,
            date: new Date(match.utcDate).toLocaleDateString()
          });
        }
      });
      
      // Calculate expected goals and dominance
      const avgGoalsPerMatch = (team1Goals + team2Goals) / h2hMatches.length;
      const team1WinRate = (team1Wins / h2hMatches.length) * 100;
      const team2WinRate = (team2Wins / h2hMatches.length) * 100;
      const drawRate = (draws / h2hMatches.length) * 100;
      
      // Calculate weighted dominance (more recent matches count more)
      let weightedDominance = 0;
      h2hMatches.forEach((match, idx) => {
        const weight = 1 + (idx < 3 ? 0.5 : 0); // 50% extra weight for last 3 matches
        const isTeam1Home = match.homeTeam.id === team1Id;
        const team1Score = isTeam1Home ? match.score.fullTime.home : match.score.fullTime.away;
        const team2Score = isTeam1Home ? match.score.fullTime.away : match.score.fullTime.home;
        
        if (team1Score > team2Score) weightedDominance += weight;
        else if (team1Score < team2Score) weightedDominance -= weight;
      });
      
      const dominanceScore = ((weightedDominance / h2hMatches.length) + 1) * 50;
      
      return {
        totalMatches: h2hMatches.length,
        team1Wins,
        team2Wins,
        draws,
        team1Goals,
        team2Goals,
        team1WinRate: Number(team1WinRate.toFixed(1)),
        team2WinRate: Number(team2WinRate.toFixed(1)),
        drawRate: Number(drawRate.toFixed(1)),
        avgGoalsPerMatch: Number(avgGoalsPerMatch.toFixed(2)),
        homeAdvantage: {
          team1HomeWins,
          team1AwayWins,
          homeWinRatio: team1Wins > 0 ? ((team1HomeWins / team1Wins) * 100).toFixed(1) : 0
        },
        recentForm,
        advantage: team1Wins > team2Wins ? team1 : team2Wins > team1Wins ? team2 : 'Balanced',
        dominance: Number(dominanceScore.toFixed(1)),
        reliability: h2hMatches.length > 5 ? 'high' : 'medium',
        isMockData: false
      };
      
    } catch (error) {
      console.error("Error fetching head-to-head:", error.message);
      return { 
        ...this.generateMockHeadToHead(team1, team2), 
        isMockData: true,
        error: error.message,
        reliability: 'low'
      };
    }
  }

  // ─── Fetch Team Form with Advanced Metrics ───────────────────────────
  async getTeamForm(teamName, matches = this.config.formMatchLimit) {
    try {
      teamName = this.validateTeamName(teamName);
      
      console.log(`📈 Analyzing form for: ${teamName}`);
      
      const teamId = await this.findTeamId(teamName);
      if (!teamId) {
        return { ...this.generateMockForm(teamName), isMockData: true };
      }
      
      const response = await axios.get(
        `${this.apiBase}/teams/${teamId}/matches?limit=20&status=FINISHED`,
        { headers: this.headers, timeout: 8000 }
      );
      
      const allMatches = response.data.matches || [];
      if (allMatches.length === 0) {
        return { ...this.generateMockForm(teamName), isMockData: true };
      }
      
      // Get recent matches with proper ordering (newest first)
      const recentMatches = allMatches.slice(0, matches);
      
      let form = [];
      let points = 0;
      let goalsFor = 0, goalsAgainst = 0;
      let cleanSheets = 0;
      let comeFromBehind = 0;
      let firstToScore = 0;
      
      recentMatches.forEach((match, index) => {
        const isHome = match.homeTeam.id === teamId;
        const teamScore = isHome ? match.score.fullTime.home : match.score.fullTime.away;
        const opponentScore = isHome ? match.score.fullTime.away : match.score.fullTime.home;
        
        goalsFor += teamScore;
        goalsAgainst += opponentScore;
        
        if (opponentScore === 0) cleanSheets++;
        
        // Check if they scored first (simplified - assumes home team kicks off)
        if (index === 0) { // Just for first match as example
          // This would need actual timeline data from API
        }
        
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
          date: new Date(match.utcDate).toLocaleDateString(),
          isHome,
          goalDiff: teamScore - opponentScore
        });
      });
      
      const formString = form.map(f => f.result).join('');
      
      // Calculate weighted form score (more recent matches count more)
      let weightedScore = 0;
      let totalWeight = 0;
      form.forEach((f, idx) => {
        const weight = 1 + (idx < 3 ? 0.3 : 0); // Recent 3 matches weighted more
        totalWeight += weight;
        if (f.result === 'W') weightedScore += 3 * weight;
        else if (f.result === 'D') weightedScore += 1 * weight;
      });
      
      const formScore = (weightedScore / (totalWeight * 3)) * 100;
      
      // Calculate expected goals and defensive strength
      const xGFor = goalsFor / matches;
      const xGAgainst = goalsAgainst / matches;
      const goalDiff = goalsFor - goalsAgainst;
      
      // Momentum calculation (last 3 matches trend)
      const last3Results = form.slice(0, 3).map(f => f.result);
      const momentum = 
        last3Results.filter(r => r === 'W').length >= 2 ? 'positive' :
        last3Results.filter(r => r === 'L').length >= 2 ? 'negative' : 'neutral';
      
      return {
        team: teamName,
        recentForm: form,
        formString,
        formScore: Number(formScore.toFixed(1)),
        points,
        goalsFor,
        goalsAgainst,
        goalDiff,
        averageGoalsFor: Number(xGFor.toFixed(2)),
        averageGoalsAgainst: Number(xGAgainst.toFixed(2)),
        cleanSheets,
        cleanSheetRate: Number(((cleanSheets / matches) * 100).toFixed(1)),
        formRating: this.calculateFormRating(formString),
        trend: this.analyzeTrend(formString),
        momentum,
        reliability: matches >= 5 ? 'high' : 'medium',
        isMockData: false
      };
      
    } catch (error) {
      console.error("Error fetching team form:", error.message);
      return { ...this.generateMockForm(teamName), isMockData: true };
    }
  }

  // ─── AI Prediction Model with Proper Probability Distribution ────────
  async predictOutcome(homeTeam, awayTeam) {
    try {
      homeTeam = this.validateTeamName(homeTeam);
      awayTeam = this.validateTeamName(awayTeam);
      
      console.log(`🤖 AI predicting: ${homeTeam} vs ${awayTeam}`);
      
      const [h2h, homeForm, awayForm] = await Promise.all([
        this.getHeadToHead(homeTeam, awayTeam),
        this.getTeamForm(homeTeam),
        this.getTeamForm(awayTeam)
      ]);
      
      // Calculate raw scores
      const homeFormScore = homeForm.formScore || 50;
      const awayFormScore = awayForm.formScore || 50;
      
      // Apply home advantage
      const adjustedHomeForm = homeFormScore * this.config.homeAdvantage;
      
      // Calculate H2H score
      let h2hScore = 50;
      if (h2h.totalMatches > 0 && !h2h.isMockData) {
        h2hScore = (h2h.team1Wins * 3 + h2h.draws) / (h2h.totalMatches * 3) * 100;
      }
      
      // Weighted combination
      const rawHome = (
        adjustedHomeForm * this.config.weights.form +
        h2hScore * this.config.weights.h2h +
        (100 - awayFormScore) * this.config.weights.recent
      ) / (this.config.weights.form + this.config.weights.h2h + this.config.weights.recent);
      
      const rawAway = (
        awayFormScore * this.config.weights.form +
        (100 - h2hScore) * this.config.weights.h2h +
        (100 - homeFormScore) * this.config.weights.recent
      ) / (this.config.weights.form + this.config.weights.h2h + this.config.weights.recent);
      
      // Base draw probability - influenced by team strengths
      const strengthDiff = Math.abs(homeFormScore - awayFormScore);
      const adjustedDrawProb = this.config.baseDrawProb + (strengthDiff * 0.2);
      
      // Normalize probabilities to sum to 100
      const total = rawHome + rawAway + adjustedDrawProb;
      const homeWinProb = (rawHome / total) * 100;
      const awayWinProb = (rawAway / total) * 100;
      const drawProb = (adjustedDrawProb / total) * 100;
      
      // Generate insights
      const insights = this.generateInsights(homeTeam, awayTeam, {
        h2h, homeForm, awayForm, homeWinProb, awayWinProb, drawProb
      });
      
      // Calculate confidence based on data quality
      const dataQuality = [
        !h2h.isMockData ? 1 : 0,
        !homeForm.isMockData ? 1 : 0,
        !awayForm.isMockData ? 1 : 0
      ].reduce((a, b) => a + b, 0) / 3;
      
      const confidence = this.calculateConfidence(
        homeWinProb, awayWinProb, drawProb, dataQuality
      );
      
      return {
        prediction: {
          homeWin: Number(homeWinProb.toFixed(1)),
          draw: Number(drawProb.toFixed(1)),
          awayWin: Number(awayWinProb.toFixed(1))
        },
        mostLikely: homeWinProb > awayWinProb && homeWinProb > drawProb ? 'HOME_WIN' : 
                    awayWinProb > homeWinProb && awayWinProb > drawProb ? 'AWAY_WIN' : 'DRAW',
        confidence,
        insights,
        statistics: {
          headToHead: {
            totalMatches: h2h.totalMatches || 0,
            team1Wins: h2h.team1Wins || 0,
            team2Wins: h2h.team2Wins || 0,
            draws: h2h.draws || 0,
            dominance: h2h.dominance || 50,
            reliability: h2h.reliability || 'low'
          },
          homeTeamForm: {
            formString: homeForm.formString || '-----',
            formRating: homeForm.formRating || 'Unknown',
            averageGoalsFor: homeForm.averageGoalsFor || 0,
            averageGoalsAgainst: homeForm.averageGoalsAgainst || 0,
            momentum: homeForm.momentum || 'neutral'
          },
          awayTeamForm: {
            formString: awayForm.formString || '-----',
            formRating: awayForm.formRating || 'Unknown',
            averageGoalsFor: awayForm.averageGoalsFor || 0,
            averageGoalsAgainst: awayForm.averageGoalsAgainst || 0,
            momentum: awayForm.momentum || 'neutral'
          }
        },
        keyFactors: this.identifyKeyFactors(h2h, homeForm, awayForm),
        dataQuality: dataQuality > 0.66 ? 'high' : dataQuality > 0.33 ? 'medium' : 'low'
      };
      
    } catch (error) {
      console.error("Prediction error:", error);
      return {
        prediction: { homeWin: 33.3, draw: 33.3, awayWin: 33.3 },
        mostLikely: 'UNKNOWN',
        confidence: 'Low',
        insights: ['Unable to generate prediction due to data error'],
        statistics: {},
        keyFactors: ['Technical error in analysis'],
        dataQuality: 'low'
      };
    }
  }

  // ─── Helper: Calculate Form Rating ──────────────────────────────────
  calculateFormRating(formString) {
    if (!formString) return 'Unknown';
    const wins = (formString.match(/W/g) || []).length;
    const losses = (formString.match(/L/g) || []).length;
    
    if (wins >= 5) return 'Excellent';
    if (wins >= 4) return 'Very Good';
    if (wins >= 3) return 'Good';
    if (wins >= 2) return 'Average';
    if (wins >= 1 || losses < 3) return 'Below Average';
    return 'Poor';
  }

  // ─── Helper: Analyze Trend ──────────────────────────────────────────
  analyzeTrend(formString) {
    if (!formString) return '↔️ Unknown';
    const last3 = formString.slice(-3);
    if (last3 === 'WWW') return '🚀 Excellent';
    if (last3 === 'LLL') return '📉 Poor';
    if (last3.match(/WW/g)) return '📈 Improving';
    if (last3.match(/LL/g)) return '📊 Declining';
    return '↔️ Stable';
  }

  // ─── Helper: Generate AI Insights ───────────────────────────────────
  generateInsights(homeTeam, awayTeam, data) {
    const insights = [];
    
    // Head-to-head insights
    if (data.h2h.totalMatches >= 3) {
      if (data.h2h.team1Wins > data.h2h.team2Wins * 2) {
        insights.push(`⚔️ ${homeTeam} dominates historically (${data.h2h.team1Wins}-${data.h2h.team2Wins} in last ${data.h2h.totalMatches})`);
      } else if (data.h2h.team2Wins > data.h2h.team1Wins * 2) {
        insights.push(`⚔️ ${awayTeam} has historical advantage (${data.h2h.team2Wins}-${data.h2h.team1Wins})`);
      } else if (data.h2h.draws > data.h2h.totalMatches / 2) {
        insights.push(`⚔️ These teams often draw (${data.h2h.draws} draws)`);
      }
    }
    
    // Form insights
    if (data.homeForm.formRating === 'Excellent' || data.homeForm.formRating === 'Very Good') {
      insights.push(`🔥 ${homeTeam} in ${data.homeForm.formRating.toLowerCase()} form (${data.homeForm.formString})`);
    }
    if (data.awayForm.formRating === 'Excellent' || data.awayForm.formRating === 'Very Good') {
      insights.push(`🔥 ${awayTeam} in ${data.awayForm.formRating.toLowerCase()} form (${data.awayForm.formString})`);
    }
    
    // Goal scoring insights
    if (data.homeForm.averageGoalsFor > 2) {
      insights.push(`⚽ ${homeTeam} scores ${data.homeForm.averageGoalsFor} goals/game - strong attack`);
    }
    if (data.awayForm.averageGoalsAgainst > 2) {
      insights.push(`🛡️ ${awayTeam} concedes ${data.awayForm.averageGoalsAgainst} goals/game - defensive weakness`);
    }
    
    // Momentum insights
    if (data.homeForm.momentum === 'positive' && data.awayForm.momentum === 'negative') {
      insights.push(`📈 Momentum heavily favors ${homeTeam}`);
    }
    if (data.awayForm.momentum === 'positive' && data.homeForm.momentum === 'negative') {
      insights.push(`📈 Momentum heavily favors ${awayTeam}`);
    }
    
    // Goal difference insights
    if (data.homeForm.goalDiff > 5 && data.awayForm.goalDiff < -3) {
      insights.push(`📊 Massive goal difference advantage for ${homeTeam}`);
    }
    
    return insights;
  }

  // ─── Helper: Identify Key Factors ───────────────────────────────────
  identifyKeyFactors(h2h, homeForm, awayForm) {
    const factors = [];
    
    if (homeForm.formRating === 'Excellent' && awayForm.formRating === 'Poor') {
      factors.push('Major form disparity - home team heavy favorite');
    } else if (homeForm.formRating === 'Excellent' && awayForm.formRating === 'Average') {
      factors.push('Home team has clear form advantage');
    }
    
    if (h2h.advantage && h2h.advantage !== 'Balanced' && !h2h.isMockData) {
      factors.push(`${h2h.advantage} has historical edge in this fixture`);
    }
    
    if (homeForm.averageGoalsFor > 2 && awayForm.averageGoalsAgainst > 1.8) {
      factors.push('Expected goals - home team should score');
    }
    
    if (homeForm.cleanSheetRate > 40 && awayForm.averageGoalsFor < 1) {
      factors.push('Home defense likely to keep clean sheet');
    }
    
    if (Math.abs(homeForm.formScore - awayForm.formScore) < 5) {
      factors.push('Very evenly matched teams');
    }
    
    return factors;
  }

  // ─── Helper: Calculate Confidence with Data Quality ─────────────────
  calculateConfidence(home, away, draw, dataQuality = 1) {
    const maxProb = Math.max(home, away, draw);
    let baseConfidence = 'Low';
    
    if (maxProb > 70) baseConfidence = 'High';
    else if (maxProb > 55) baseConfidence = 'Medium';
    else baseConfidence = 'Low';
    
    // Adjust for data quality
    if (dataQuality < 0.5 && baseConfidence === 'High') return 'Medium';
    if (dataQuality < 0.3 && baseConfidence !== 'Low') return 'Low';
    
    return baseConfidence;
  }

  // ─── Mock Data Generators ───────────────────────────────────────────
  generateMockHeadToHead(team1, team2) {
    const totalMatches = Math.floor(Math.random() * 4) + 2;
    const team1Wins = Math.floor(Math.random() * (totalMatches));
    const team2Wins = Math.floor(Math.random() * (totalMatches - team1Wins));
    const draws = totalMatches - team1Wins - team2Wins;
    
    return {
      totalMatches,
      team1Wins,
      team2Wins,
      draws,
      team1Goals: team1Wins * 2 + draws,
      team2Goals: team2Wins * 2 + draws,
      team1WinRate: Number(((team1Wins / totalMatches) * 100).toFixed(1)),
      team2WinRate: Number(((team2Wins / totalMatches) * 100).toFixed(1)),
      drawRate: Number(((draws / totalMatches) * 100).toFixed(1)),
      avgGoalsPerMatch: Number(((team1Wins * 2 + team2Wins * 2 + draws * 2) / totalMatches).toFixed(2)),
      recentMatches: [],
      advantage: team1Wins > team2Wins ? team1 : team2Wins > team1Wins ? team2 : 'Balanced',
      dominance: Number(((team1Wins + draws/2) / totalMatches * 100).toFixed(1)),
      reliability: 'low'
    };
  }

  generateMockForm(teamName) {
    const form = [];
    const results = ['W', 'D', 'L'];
    let formString = '';
    
    for (let i = 0; i < 5; i++) {
      const result = results[Math.floor(Math.random() * 3)];
      formString += result;
      const homeScore = Math.floor(Math.random() * 3);
      const awayScore = Math.floor(Math.random() * 3);
      form.push({
        opponent: 'Opponent FC',
        result,
        score: `${homeScore}-${awayScore}`,
        date: new Date(Date.now() - i * 86400000).toLocaleDateString(),
        isHome: Math.random() > 0.5,
        goalDiff: homeScore - awayScore
      });
    }
    
    const wins = (formString.match(/W/g) || []).length;
    const draws = (formString.match(/D/g) || []).length;
    const goalsFor = Math.floor(Math.random() * 8) + 3;
    const goalsAgainst = Math.floor(Math.random() * 6) + 2;
    
    return {
      team: teamName,
      recentForm: form,
      formString,
      formScore: (wins * 3 + draws) / 15 * 100,
      points: wins * 3 + draws,
      goalsFor,
      goalsAgainst,
      goalDiff: goalsFor - goalsAgainst,
      averageGoalsFor: Number((goalsFor / 5).toFixed(2)),
      averageGoalsAgainst: Number((goalsAgainst / 5).toFixed(2)),
      cleanSheets: Math.floor(Math.random() * 2),
      cleanSheetRate: Number((Math.random() * 40).toFixed(1)),
      formRating: wins >= 3 ? 'Good' : wins >= 2 ? 'Average' : 'Below Average',
      trend: '↔️ Stable',
      momentum: wins >= 3 ? 'positive' : wins <= 1 ? 'negative' : 'neutral',
      reliability: 'low'
    };
  }
}

module.exports = AIAnalysisAgent;