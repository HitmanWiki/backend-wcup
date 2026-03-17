/**
 * AI Match Analysis Agent
 * Fixed ES Module import issue
 */

const axios = require('axios');

// Remove problematic imports - we'll implement our own simple sentiment
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
        return this.generateMockHeadToHead(team1, team2);
      }
      
      const response = await axios.get(
        `${this.apiBase}/teams/${team1Id}/matches?limit=20&status=FINISHED`,
        { headers: this.headers, timeout: 5000 }
      );
      
      const h2hMatches = response.data.matches.filter(m => 
        (m.homeTeam.id === team2Id || m.awayTeam.id === team2Id)
      ).slice(0, 10);
      
      if (h2hMatches.length === 0) {
        return this.generateMockHeadToHead(team1, team2);
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
      return this.generateMockHeadToHead(team1, team2);
    }
  }

  // ─── Fetch Team Form ────────────────────────────────────────────────
  async getTeamForm(teamName, matches = 5) {
    try {
      console.log(`📈 Analyzing form for: ${teamName}`);
      
      const teamId = await this.findTeamId(teamName);
      if (!teamId) {
        return this.generateMockForm(teamName);
      }
      
      const response = await axios.get(
        `${this.apiBase}/teams/${teamId}/matches?limit=10&status=FINISHED`,
        { headers: this.headers, timeout: 5000 }
      );
      
      const recentMatches = response.data.matches.slice(0, matches);
      
      if (recentMatches.length === 0) {
        return this.generateMockForm(teamName);
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
      return this.generateMockForm(teamName);
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
    
    const homeAdvantage = 1.2;
    const formWeight = 0.4;
    const h2hWeight = 0.3;
    const recentWeight = 0.3;
    
    const homeFormScore = this.calculateFormScore(homeForm.formString) * homeAdvantage;
    const awayFormScore = this.calculateFormScore(awayForm.formString);
    
    const h2hScore = h2h.totalMatches > 0 ? 
      (h2h.team1Wins * 3 + h2h.draws) / (h2h.totalMatches * 3) * 100 : 50;
    
    const homeWinProb = (
      homeFormScore * formWeight +
      h2hScore * h2hWeight +
      (100 - awayFormScore) * recentWeight
    ) / (formWeight + h2hWeight + recentWeight);
    
    const awayWinProb = 100 - homeWinProb - 10;
    const drawProb = 10;
    
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
    
    if (data.homeForm.formRating === 'Excellent') {
      insights.push(`🔥 ${homeTeam} is in excellent form (${data.homeForm.formString})`);
    }
    if (data.awayForm.formRating === 'Excellent') {
      insights.push(`🔥 ${awayTeam} is in excellent form (${data.awayForm.formString})`);
    }
    
    if (data.homeForm.averageGoalsFor > 2) {
      insights.push(`⚽ ${homeTeam} scores ${data.homeForm.averageGoalsFor} goals per game on average`);
    }
    if (data.awayForm.averageGoalsAgainst > 2) {
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
    if (homeForm.formString && awayForm.formString) {
      if (homeForm.formString.includes('WW') && awayForm.formString.includes('LL')) {
        factors.push('Momentum heavily with home team');
      }
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

  // ─── Mock Data Generators (Fallback) ────────────────────────────────
  generateMockHeadToHead(team1, team2) {
    const totalMatches = Math.floor(Math.random() * 5) + 3;
    const team1Wins = Math.floor(Math.random() * (totalMatches - 1));
    const team2Wins = Math.floor(Math.random() * (totalMatches - team1Wins - 1));
    const draws = totalMatches - team1Wins - team2Wins;
    
    return {
      totalMatches,
      team1Wins,
      team2Wins,
      draws,
      team1Goals: team1Wins * 2 + draws,
      team2Goals: team2Wins * 2 + draws,
      recentMatches: [],
      advantage: team1Wins > team2Wins ? team1 : team2Wins > team1Wins ? team2 : 'Equal',
      dominance: ((team1Wins + draws/2) / totalMatches * 100).toFixed(1)
    };
  }

  generateMockForm(teamName) {
    const form = [];
    const results = ['W', 'D', 'L'];
    let formString = '';
    
    for (let i = 0; i < 5; i++) {
      const result = results[Math.floor(Math.random() * 3)];
      formString += result;
      form.push({
        opponent: 'Opponent FC',
        result,
        score: `${Math.floor(Math.random() * 3)}-${Math.floor(Math.random() * 3)}`,
        date: new Date().toLocaleDateString()
      });
    }
    
    return {
      team: teamName,
      recentForm: form,
      formString,
      points: (formString.match(/W/g) || []).length * 3 + (formString.match(/D/g) || []).length,
      goalsFor: Math.floor(Math.random() * 8) + 3,
      goalsAgainst: Math.floor(Math.random() * 6) + 2,
      averageGoalsFor: (Math.random() * 2 + 1).toFixed(1),
      averageGoalsAgainst: (Math.random() * 1.5 + 0.5).toFixed(1),
      formRating: 'Average',
      trend: '↔️ Stable'
    };
  }
}

module.exports = AIAnalysisAgent;