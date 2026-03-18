/**
 * AI Match Analysis Agent — Google Search Grounded
 * ─────────────────────────────────────────────────
 * Works exactly like asking Claude/ChatGPT a question:
 *   - No football API keys needed
 *   - No NewsAPI needed  
 *   - Gemini searches Google in real-time for current data
 *   - 1 Gemini call per prediction
 *   - Handles neutral venues (World Cup) correctly
 *
 * Only requirement: GEMINI_API_KEY
 *
 * Setup:
 *   npm install @google/generative-ai
 *   GEMINI_API_KEY=...   https://aistudio.google.com/app/apikey
 */

"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");

class AIMatchAgent {
  constructor({ geminiApiKey }) {
    this.genAI = new GoogleGenerativeAI(geminiApiKey);
    this.model = "gemini-2.5-flash";
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PUBLIC — predict()
  //  Gemini searches Google, reads real pages, and returns analysis.
  //  Zero external APIs. Zero pre-fetching. Just like asking a human.
  // ══════════════════════════════════════════════════════════════════════

  async predict(homeTeam, awayTeam, options = {}) {
    const { competition = "Unknown", verbose = false } = options;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🤖 AGENT: ${homeTeam}  vs  ${awayTeam}`);
    console.log(`🏆 Competition: ${competition}`);
    console.log(`🔍 Gemini will search Google for live data...`);
    console.log(`${"=".repeat(60)}`);

    const model = this.genAI.getGenerativeModel({
      model : this.model,
      tools : [{ googleSearch: {} }],   // ← Gemini searches Google itself
    });

    const prompt = this._buildPrompt(homeTeam, awayTeam, competition);
    if (verbose) console.log(`\nPrompt:\n${prompt}\n`);

    let rawText;
    let groundingMetadata = null;

    try {
      const result   = await model.generateContent(prompt);
      const response = result.response;
      rawText        = response.text();

      // Capture what Gemini actually searched and read
      groundingMetadata = response.candidates?.[0]
        ?.groundingMetadata || null;

      if (verbose && groundingMetadata?.searchEntryPoint) {
        console.log("\n📚 Sources Gemini read:");
        groundingMetadata.groundingChunks?.forEach((c, i) => {
          console.log(`  [${i+1}] ${c.web?.title} — ${c.web?.uri}`);
        });
      }

    } catch (err) {
      console.error(`❌ Gemini error: ${err.message}`);
      return this._fallback(homeTeam, awayTeam, err.message);
    }

    const parsed = this._parseOutput(rawText, homeTeam, awayTeam);

    // Attach sources Gemini actually read
    parsed._meta = {
      homeTeam,
      awayTeam,
      competition,
      generatedAt  : new Date().toISOString(),
      model        : this.model,
      geminiCalls  : 1,
      searchUsed   : true,
      sources      : groundingMetadata?.groundingChunks
        ?.map(c => ({ title: c.web?.title, url: c.web?.uri }))
        .filter(s => s.url) || [],
    };

    console.log(`\n✅ Done — sources read: ${parsed._meta.sources.length}`);
    return parsed;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PROMPT BUILDER
  //  Now handles neutral venues (World Cup) correctly
  // ══════════════════════════════════════════════════════════════════════

  _buildPrompt(homeTeam, awayTeam, competition) {
    const today = new Date().toISOString().split("T")[0];
    
    // Determine if this is a World Cup match (neutral venue)
    const isWorldCup = competition?.toLowerCase().includes("world cup") || false;
    
    let venueInstruction = "";
    if (isWorldCup) {
      venueInstruction = `
⚽ IMPORTANT VENUE NOTE: This is a FIFA World Cup 2026 match played at a NEUTRAL VENUE in North America (USA/Canada/Mexico).
- There is NO HOME ADVANTAGE for either team
- Do NOT apply the standard 1.2x home advantage multiplier
- Both teams are effectively playing away
- Factor in travel distance, climate adaptation, and local support if applicable`;
    } else {
      venueInstruction = `
🏟️ VENUE NOTE: This is a standard match where the FIRST-NAMED TEAM has home advantage.
- Apply a standard 1.15-1.25x home advantage factor to their raw form scores
- Consider crowd support, familiar conditions, and no travel fatigue`;
    }

    return `Today is ${today}.

You are an elite football analyst and sports betting specialist.
Search the internet RIGHT NOW to gather the latest data on this match:

FIRST TEAM : ${homeTeam}
SECOND TEAM : ${awayTeam}
COMPETITION: ${competition}
${venueInstruction}

Search for and use REAL current data:
1. ${homeTeam} last 5-10 match results and current form (look for recent friendlies, qualifiers, tournaments)
2. ${awayTeam} last 5-10 match results and current form
3. Head-to-head history between ${homeTeam} and ${awayTeam} in all competitions
4. Current injury news, suspensions, or lineup updates for both teams
5. Goal scoring patterns: average goals scored/conceded, clean sheets
6. Any recent team news, manager comments, or match previews
7. For World Cup: consider group stage pressure, knockout implications if applicable

After searching and reading the results, produce a full betting analysis.

Return ONLY this JSON — no text outside it:

\`\`\`json
{
  "firstTeam": "${homeTeam}",
  "secondTeam": "${awayTeam}",
  "competition": "${competition}",
  "prediction": {
    "firstTeamWin": 0.0,
    "draw": 0.0,
    "secondTeamWin": 0.0
  },
  "mostLikely": "FIRST_TEAM_WIN | DRAW | SECOND_TEAM_WIN",
  "confidence": "HIGH | MEDIUM | LOW",
  "expectedGoals": {
    "firstTeam": 0.0,
    "secondTeam": 0.0,
    "total": 0.0
  },
  "bettingAngles": {
    "recommendedBet": "string (e.g., 'First Team Win', 'Draw', 'Second Team Win', 'BTTS Yes', etc.)",
    "valueBet": "string or null (the bet with best odds relative to probability)",
    "btts": "YES | NO | UNCERTAIN",
    "bttsConfidence": "HIGH | MEDIUM | LOW",
    "overUnderLine": 2.5,
    "overUnderCall": "OVER | UNDER | UNCERTAIN",
    "asianHandicap": "string or null (e.g., 'First Team -0.5', 'Second Team +0.25')",
    "avoidBets": ["list of bets to avoid"]
  },
  "teamNews": {
    "firstTeam": "summary of injuries/suspensions/lineup news",
    "secondTeam": "summary of injuries/suspensions/lineup news"
  },
  "formSummary": {
    "firstTeamForm": "last 5 results e.g. WWDLW",
    "secondTeamForm": "last 5 results e.g. WDLLW",
    "firstTeamMomentum": "positive | neutral | negative",
    "secondTeamMomentum": "positive | neutral | negative"
  },
  "h2hSummary": "one sentence summary of recent head to head",
  "keyFactors": ["factor 1", "factor 2", "factor 3"],
  "riskFactors": ["risk 1", "risk 2"],
  "analystNote": "2-3 sentence deeper insight based on what you found",
  "dataQuality": "HIGH | MEDIUM | LOW",
  "warningFlags": ["any concerns about data or predictions"]
}
\`\`\`

CRITICAL RULES:
- prediction values MUST sum to exactly 100
- ${isWorldCup ? "For World Cup: NO home advantage multiplier. Both teams are neutral." : "For standard matches: Apply 1.15-1.25x home advantage to first team."}
- Base everything on real data you searched — not training memory
- If you cannot find current form, say so in warningFlags
- Be sharp. Do not be optimistic. Calibrate probabilities carefully.
- Use team names consistently throughout the JSON`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  OUTPUT PARSER
  // ══════════════════════════════════════════════════════════════════════

  _parseOutput(text, homeTeam, awayTeam) {
    const match =
      text.match(/```json\s*([\s\S]+?)\s*```/) ||
      text.match(/(\{[\s\S]+\})/);

    if (match) {
      try {
        const parsed = JSON.parse(match[1]);

        // Handle both old and new format
        let prediction = parsed.prediction || {};
        
        // Convert old format (homeWin/draw/awayWin) to new format if needed
        if ('homeWin' in prediction && !('firstTeamWin' in parsed.prediction)) {
          parsed.prediction = {
            firstTeamWin: prediction.homeWin,
            draw: prediction.draw,
            secondTeamWin: prediction.awayWin
          };
        }
        
        // Ensure probabilities sum to 100
        const { firstTeamWin = 0, draw = 0, secondTeamWin = 0 } = parsed.prediction || {};
        const total = firstTeamWin + draw + secondTeamWin;
        
        if (Math.abs(total - 100) > 0.5) {
          parsed.prediction = {
            firstTeamWin : +((firstTeamWin / total) * 100).toFixed(1),
            draw         : +((draw / total) * 100).toFixed(1),
            secondTeamWin : +((secondTeamWin / total) * 100).toFixed(1),
          };
          parsed.warningFlags = [
            ...(parsed.warningFlags || []),
            `Probabilities normalised from ${total.toFixed(1)} to 100`,
          ];
        }

        // Add display-friendly fields for frontend
        parsed.display = {
          homeTeam: parsed.firstTeam || homeTeam,
          awayTeam: parsed.secondTeam || awayTeam,
          homeWinProb: parsed.prediction?.firstTeamWin || 0,
          drawProb: parsed.prediction?.draw || 0,
          awayWinProb: parsed.prediction?.secondTeamWin || 0
        };

        return parsed;
      } catch (e) {
        // JSON parse failed — return raw so you can debug
        return {
          homeTeam, awayTeam,
          rawAnalysis : text,
          prediction  : { firstTeamWin: null, draw: null, secondTeamWin: null },
          mostLikely  : "UNKNOWN",
          confidence  : "LOW",
          _parseError : true,
          _parseMsg   : e.message,
        };
      }
    }

    return {
      homeTeam, awayTeam,
      rawAnalysis : text,
      prediction  : { firstTeamWin: null, draw: null, secondTeamWin: null },
      mostLikely  : "UNKNOWN",
      confidence  : "LOW",
      _parseError : true,
    };
  }

  _fallback(homeTeam, awayTeam, errorMsg = "") {
    return {
      firstTeam: homeTeam,
      secondTeam: awayTeam,
      prediction: { 
        firstTeamWin: 40, 
        draw: 30, 
        secondTeamWin: 30 
      },
      mostLikely    : "FIRST_TEAM_WIN",
      confidence    : "LOW",
      bettingAngles : { 
        recommendedBet: "No bet — agent error", 
        btts: "UNCERTAIN" 
      },
      keyFactors    : ["Prediction unavailable"],
      dataQuality   : "LOW",
      warningFlags  : [errorMsg || "Gemini call failed"],
      display: {
        homeTeam,
        awayTeam,
        homeWinProb: 40,
        drawProb: 30,
        awayWinProb: 30
      },
      _meta         : {
        generatedAt : new Date().toISOString(),
        model       : this.model,
        fallback    : true,
      },
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
//  TEST — node ai-match-agent.js
// ══════════════════════════════════════════════════════════════════════

async function main() {
  const agent = new AIMatchAgent({
    geminiApiKey: process.env.GEMINI_API_KEY,
  });

  // Test with World Cup match (neutral venue)
  console.log("\n🌍 Testing World Cup match (neutral venue)...");
  const result1 = await agent.predict("South Africa", "Korea Republic", {
    competition : "FIFA World Cup 2026",
    verbose     : true,
  });

  console.log("\n====== WORLD CUP PREDICTION ======");
  console.log(JSON.stringify(result1, null, 2));

  // Test with regular match (home advantage)
  console.log("\n\n🏟️ Testing regular match (home advantage)...");
  const result2 = await agent.predict("Manchester City", "Arsenal", {
    competition : "Premier League",
    verbose     : false,
  });

  console.log("\n====== PREMIER LEAGUE PREDICTION ======");
  console.log(JSON.stringify(result2, null, 2));
}

if (require.main === module) main().catch(console.error);
module.exports = AIMatchAgent;