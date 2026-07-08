'use strict';

/**
 * scripts/analyze.js
 *
 * Daily Shopify Dropshipping Trend Analyzer — Two-Phase Pipeline
 * ---------------------------------------------------------------
 *  Phase 1 — The Researcher:
 *    Calls gemini-2.5-flash with Google Search Grounding enabled.
 *    Returns raw markdown/text with real web-sourced data on pricing,
 *    TikTok/Meta ad trends, AliExpress sourcing costs, and source links.
 *
 *  Phase 2 — The Parser:
 *    Passes the raw research to a second Gemini call configured with
 *    JSON Schema mode (responseSchema + responseMimeType).
 *    Extracts a clean, structured product list and writes it to
 *    data/today.json for the static frontend to consume.
 *
 *  Usage:
 *    node scripts/analyze.js [COUNTRY_CODE]
 *    npm run analyze
 *    npm run analyze -- GB
 *    GEMINI_API_KEY=xxx node scripts/analyze.js US
 *
 *  Required env var:
 *    GEMINI_API_KEY — set as a GitHub Actions secret named GEMINI_API_KEY
 */

// ─── Imports (CommonJS) ───────────────────────────────────────────────────────
const { GoogleGenAI, Type } = require('@google/genai');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY     = process.env.GEMINI_API_KEY;
const COUNTRY     = (process.argv[2] || 'US').toUpperCase().trim();
const TODAY       = new Date().toISOString().split('T')[0];
const OUTPUT_PATH = path.resolve(__dirname, '../data/today.json');
const MODEL       = 'gemini-2.5-flash';

// Validate API key up front
if (!API_KEY) {
  console.error('❌  GEMINI_API_KEY environment variable is not set.');
  console.error('    Export it or pass it inline: GEMINI_API_KEY=xxx node scripts/analyze.js');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// ─── Country → Currency mapping ───────────────────────────────────────────────
const COUNTRY_META = {
  US: { name: 'United States', currency: 'USD', marketplaces: 'Amazon US, Etsy, Shopify US' },
  GB: { name: 'United Kingdom', currency: 'GBP', marketplaces: 'Amazon UK, ASOS, Shopify UK' },
  AU: { name: 'Australia',      currency: 'AUD', marketplaces: 'Amazon AU, Catch, Shopify AU' },
  CA: { name: 'Canada',         currency: 'CAD', marketplaces: 'Amazon CA, Shopify CA'        },
  DE: { name: 'Germany',        currency: 'EUR', marketplaces: 'Amazon DE, Otto, Shopify DE'  },
  FR: { name: 'France',         currency: 'EUR', marketplaces: 'Amazon FR, Cdiscount'         },
};
const meta = COUNTRY_META[COUNTRY] || { name: COUNTRY, currency: 'USD', marketplaces: 'major retail platforms' };

// ─────────────────────────────────────────────────────────────────────────────
//  PHASE 1 — THE RESEARCHER
//  Google Search Grounding ON. Returns free-text research with real URLs.
// ─────────────────────────────────────────────────────────────────────────────
async function runResearcher() {
  console.log(`\n🔍  [Phase 1] Researcher starting for ${meta.name} (${COUNTRY}) on ${TODAY}...`);

  const prompt = [
    `Today is ${TODAY}. You are a world-class e-commerce trend analyst.`,
    ``,
    `USE Google Search RIGHT NOW to research the TOP 5 Shopify dropshipping products`,
    `to sell in ${meta.name} (${COUNTRY}) today.`,
    ``,
    `For EACH of the 5 products, search for and include ALL of the following:`,
    ``,
    `1. PRODUCT NAME & NICHE — Be specific (e.g. "Portable Car Tyre Inflator", not just "car accessory")`,
    `2. TREND SIGNALS — Evidence of viral TikTok/Reels videos, hashtag volume, or Meta ad activity right now`,
    `3. COMPETITOR RETAIL PRICE — Search ${meta.marketplaces} for the current retail selling price in ${meta.currency}`,
    `4. ALIEXPRESS / CJDROPSHIPPING SOURCE PRICE — Find the actual source price in USD from AliExpress or CJdropshipping`,
    `5. ESTIMATED PROFIT MARGIN — Calculate: ((retail - source) / retail) * 100`,
    `6. SUPPLIER & SHIPPING — Best supplier platform and estimated shipping speed to ${meta.name}`,
    `7. SOURCE LINK — Provide a REAL URL: either the AliExpress/CJdropshipping product listing OR a TikTok/news article proving the trend`,
    ``,
    `Scoring criteria (rank products by these factors combined):`,
    `- High social proof / viral momentum right now`,
    `- Gross margin > 40%`,
    `- Source price under $15 USD ideally`,
    `- Low-to-moderate ad saturation (opportunity window still open)`,
    `- Impulse-buy potential (clear problem/desire solved)`,
    ``,
    `Format your response as a detailed research brief with all 5 products clearly numbered.`,
    `Include real prices, real URLs, and specific reasoning for every product.`,
  ].join('\n');

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 1,  // Required for thinking models; grounding works best with balanced temp
    },
  });

  const researchText = response.text;
  if (!researchText || researchText.trim().length < 100) {
    throw new Error('Researcher returned an empty or too-short response.');
  }

  console.log(`✅  [Phase 1] Research complete. (~${researchText.length} chars received)`);

  // Log grounding metadata if present (search queries used)
  const groundingMeta = response.candidates?.[0]?.groundingMetadata;
  if (groundingMeta?.searchEntryPoint?.renderedContent) {
    console.log('    📡  Search grounding was active.');
  }
  if (groundingMeta?.webSearchQueries?.length) {
    console.log(`    🔎  Queries used: ${groundingMeta.webSearchQueries.join(' | ')}`);
  }

  return researchText;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHASE 2 — THE PARSER
//  Strict JSON Schema mode. No tools. Extracts structured data from research.
// ─────────────────────────────────────────────────────────────────────────────
async function runParser(researchText) {
  console.log(`\n🧠  [Phase 2] Parser extracting structured JSON from research...`);

  // ── JSON Response Schema ────────────────────────────────────────────────────
  const responseSchema = {
    type: Type.OBJECT,
    description: 'Root object containing the daily product report',
    required: ['generatedAt', 'country', 'products'],
    properties: {
      generatedAt: {
        type: Type.STRING,
        description: 'ISO 8601 timestamp of when this report was generated',
      },
      country: {
        type: Type.STRING,
        description: 'ISO country code this report targets (e.g. US, GB)',
      },
      products: {
        type: Type.ARRAY,
        description: 'Ordered list of top 5 dropshipping products, rank 1 being the best',
        minItems: 5,
        maxItems: 5,
        items: {
          type: Type.OBJECT,
          required: ['rank', 'name', 'niche', 'sourcePrice', 'retailPrice', 'margin', 'marginVal', 'trendScore', 'supplierHint', 'reasonToSell', 'tags', 'sourceLink'],
          properties: {
            rank: {
              type: Type.INTEGER,
              description: 'Product rank from 1 (best) to 5',
              minimum: 1,
              maximum: 5,
            },
            name: {
              type: Type.STRING,
              description: 'Specific, descriptive product name (not a generic category)',
            },
            niche: {
              type: Type.STRING,
              description: 'Market niche or category (e.g. "Pet Supplies", "Home & Kitchen")',
            },
            sourcePrice: {
              type: Type.NUMBER,
              description: 'AliExpress or CJdropshipping source price in USD',
            },
            retailPrice: {
              type: Type.NUMBER,
              description: 'Competitor retail price in the target country converted to USD',
            },
            margin: {
              type: Type.STRING,
              description: 'Gross profit margin as a percentage string, e.g. "68%"',
            },
            marginVal: {
              type: Type.NUMBER,
              description: 'Gross profit in USD per unit sold (retailPrice - sourcePrice)',
            },
            trendScore: {
              type: Type.INTEGER,
              description: 'Trend momentum score from 1 (low) to 100 (viral/peak)',
              minimum: 1,
              maximum: 100,
            },
            supplierHint: {
              type: Type.STRING,
              description: 'Supplier platform and estimated shipping speed, e.g. "AliExpress — 7-14 days ePacket"',
            },
            reasonToSell: {
              type: Type.STRING,
              description: 'One compelling sentence explaining why this product wins right now',
            },
            tags: {
              type: Type.ARRAY,
              description: 'Array of 3-5 short keyword tags for this product',
              items: { type: Type.STRING },
              minItems: 3,
              maxItems: 5,
            },
            sourceLink: {
              type: Type.STRING,
              description: 'Real URL to the AliExpress/CJ listing or a TikTok/news article proving the trend',
            },
          },
        },
      },
    },
  };

  const parserPrompt = [
    `You are a precise data extraction assistant.`,
    `Below is a dropshipping research brief for ${meta.name} (${COUNTRY}) generated on ${TODAY}.`,
    `Extract ALL product data from it and populate the JSON schema exactly.`,
    ``,
    `Rules:`,
    `- sourcePrice must be in USD (convert if needed using approximate rates)`,
    `- retailPrice must be in USD (convert if needed)`,
    `- marginVal = retailPrice - sourcePrice (rounded to 2 decimal places)`,
    `- margin = round((marginVal / retailPrice) * 100) + "%"`,
    `- trendScore: synthesise from the trend signals described (viral = 85-100, growing = 60-84, stable = 40-59)`,
    `- sourceLink: use the most relevant real URL found in the research; if none found, use "https://www.aliexpress.com/wholesale?SearchText=" + encodeURIComponent(productName)`,
    `- Output ONLY the JSON object. No markdown fences, no commentary.`,
    ``,
    `=== RESEARCH BRIEF ===`,
    researchText,
  ].join('\n');

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: parserPrompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0.1,  // Low temp for deterministic extraction
    },
  });

  const rawJson = response.text.trim();
  console.log(`✅  [Phase 2] Parser returned ${rawJson.length} chars of JSON.`);

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (parseErr) {
    console.error('❌  [Phase 2] Failed to parse JSON response:');
    console.error(rawJson.slice(0, 500));
    throw parseErr;
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log('  🛒  Dropship Trend Agent — Daily Analysis Pipeline');
  console.log(`  📅  Date    : ${TODAY}`);
  console.log(`  🌍  Country : ${meta.name} (${COUNTRY})`);
  console.log(`  🤖  Model   : ${MODEL}`);
  console.log('════════════════════════════════════════════════════════');

  try {
    // ── Phase 1: Web-grounded research ───────────────────────────────────────
    const researchText = await runResearcher();

    // ── Phase 2: Structured JSON extraction ──────────────────────────────────
    const data = await runParser(researchText);

    // ── Stamp metadata ────────────────────────────────────────────────────────
    data.generatedAt = new Date().toISOString();
    data.country     = COUNTRY;
    data.note        = 'Auto-generated by scripts/analyze.js. Do not edit manually.';

    // ── Validate product count ────────────────────────────────────────────────
    if (!Array.isArray(data.products) || data.products.length === 0) {
      throw new Error('Parser returned no products. Aborting write.');
    }

    // ── Write output ──────────────────────────────────────────────────────────
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`\n💾  Written to: ${OUTPUT_PATH}`);

    // ── Summary table ─────────────────────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════');
    console.log(`  📊  TODAY'S TOP ${data.products.length} PRODUCTS (${COUNTRY})`);
    console.log('════════════════════════════════════════════════════════');
    data.products.forEach((p) => {
      const pad  = String(p.rank).padStart(2, ' ');
      const name = (p.name || '').padEnd(38, ' ').slice(0, 38);
      console.log(
        `  ${pad}. ${name}  |  src $${String(p.sourcePrice).padStart(5)}  ret $${String(p.retailPrice).padStart(6)}  ${p.margin.padStart(4)} margin  score ${p.trendScore}`
      );
    });
    console.log('════════════════════════════════════════════════════════');
    console.log('  ✅  Pipeline complete.\n');

  } catch (err) {
    console.error('\n❌  Pipeline failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
