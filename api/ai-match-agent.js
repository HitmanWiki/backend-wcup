/**
 * AI Match Analysis Agent — Google Search Grounded
 * ─────────────────────────────────────────────────
 * Works exactly like asking Claude/ChatGPT a question:
 *   - No football API keys needed
 *   - No NewsAPI needed  
 *   - Gemini searches Google in real-time for current data
 *   - 1 Gemini call per prediction
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
    console.log(`AGENT: ${homeTeam}  vs  ${awayTeam}`);
    console.log(`Gemini will search Google for live data...`);
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
        console.log("\nGemini searched:");
        groundingMetadata.groundingChunks?.forEach((c, i) => {
          console.log(`  [${i+1}] ${c.web?.title} — ${c.web?.uri}`);
        });
      }

    } catch (err) {
      console.error(`Gemini error: ${err.message}`);
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

    console.log(`\nDone — sources read: ${parsed._meta.sources.length}`);
    return parsed;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PROMPT
  //  Written exactly like how you'd ask a human analyst.
  //  Gemini will search for what it needs automatically.
  // ══════════════════════════════════════════════════════════════════════

  _buildPrompt(homeTeam, awayTeam, competition) {
    const today = new Date().toISOString().split("T")[0];

    return `Today is ${today}.

You are an elite football analyst and sports betting specialist.
Search the internet RIGHT NOW to gather the latest data on this match:

HOME TEAM : ${homeTeam}
AWAY TEAM : ${awayTeam}  
COMPETITION: ${competition}

Search for and use REAL current data:
1. ${homeTeam} last 5-10 match results and current form
2. ${awayTeam} last 5-10 match results and current form
3. Head-to-head history between ${homeTeam} and ${awayTeam}
4. Current injury news, suspensions, or lineup updates for both teams
5. ${homeTeam} vs ${awayTeam} historical stats and goal patterns
6. Any recent team news, manager comments, or match previews

After searching and reading the results, produce a full betting analysis.

Return ONLY this JSON — no text outside it:

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
  "teamNews": {
    "homeTeam": "injury/suspension/lineup news found",
    "awayTeam": "injury/suspension/lineup news found"
  },
  "formSummary": {
    "homeTeamForm": "last 5 results e.g. WWDLW",
    "awayTeamForm": "last 5 results e.g. WDLLW",
    "homeMomentum": "positive | neutral | negative",
    "awayMomentum": "positive | neutral | negative"
  },
  "h2hSummary": "one sentence summary of recent head to head",
  "keyFactors": ["factor 1", "factor 2", "factor 3"],
  "riskFactors": ["risk 1", "risk 2"],
  "analystNote": "2-3 sentence deeper insight based on what you found",
  "dataQuality": "HIGH | MEDIUM | LOW",
  "warningFlags": ["any concerns about data or predictions"]
}
\`\`\`

Rules:
- prediction values MUST sum to exactly 100
- Base everything on real data you searched — not training memory
- If you cannot find current form, say so in warningFlags
- Be sharp. Do not be optimistic. Calibrate probabilities carefully.`;
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

        // Ensure probabilities sum to 100
        const { homeWin = 0, draw = 0, awayWin = 0 } = parsed.prediction || {};
        const total = homeWin + draw + awayWin;
        if (Math.abs(total - 100) > 0.5) {
          parsed.prediction = {
            homeWin : +((homeWin / total) * 100).toFixed(1),
            draw    : +((draw    / total) * 100).toFixed(1),
            awayWin : +((awayWin / total) * 100).toFixed(1),
          };
          parsed.warningFlags = [
            ...(parsed.warningFlags || []),
            `Probabilities normalised from ${total.toFixed(1)} to 100`,
          ];
        }

        return parsed;
      } catch (e) {
        // JSON parse failed — return raw so you can debug
        return {
          homeTeam, awayTeam,
          rawAnalysis : text,
          prediction  : { homeWin: null, draw: null, awayWin: null },
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
      prediction  : { homeWin: null, draw: null, awayWin: null },
      mostLikely  : "UNKNOWN",
      confidence  : "LOW",
      _parseError : true,
    };
  }

  _fallback(homeTeam, awayTeam, errorMsg = "") {
    return {
      homeTeam, awayTeam,
      prediction    : { homeWin: 40, draw: 25, awayWin: 35 },
      mostLikely    : "HOME_WIN",
      confidence    : "LOW",
      bettingAngles : { recommendedBet: "No bet — agent error", btts: "UNCERTAIN" },
      keyFactors    : ["Prediction unavailable"],
      dataQuality   : "LOW",
      warningFlags  : [errorMsg || "Gemini call failed"],
      _meta         : {
        generatedAt : new Date().toISOString(),
        model       : this.model,
        fallback    : true,
      },
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
//  TEST — node AIMatchAgent_Gemini.js
// ══════════════════════════════════════════════════════════════════════

async function main() {
  const agent = new AIMatchAgent({
    geminiApiKey: process.env.GEMINI_API_KEY,
  });

  const result = await agent.predict("Brazil", "Argentina", {
    competition : "FIFA World Cup 2026",
    verbose     : true,
  });

  console.log("\n====== PREDICTION RESULT ======");
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(console.error);
module.exports = AIMatchAgent;