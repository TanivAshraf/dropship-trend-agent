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
//  RETRY HELPER — Exponential backoff for transient Gemini API errors
// ─────────────────────────────────────────────────────────────────────────────

// Error codes / message fragments that indicate a transient server-side issue
// and are safe to retry.  Anything else is a logic/auth error — fail fast.
const TRANSIENT_PATTERNS = ['503', '429', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED'];

/**
 * Calls ai.models.generateContent(options) with automatic retry on transient
 * Gemini API errors (rate-limits, service unavailability).
 *
 * @param {object} options      - Options object passed directly to generateContent
 * @param {number} maxRetries   - Maximum number of retry attempts (default 3)
 * @returns {Promise<object>}   - The successful GenerateContentResponse
 * @throws                      - Re-throws after maxRetries or on non-transient errors
 */
async function generateContentWithRetry(options, maxRetries = 3) {
  let attempt = 0;

  while (true) {
    try {
      return await ai.models.generateContent(options);
    } catch (err) {
      const message = (err.message || '').toUpperCase();
      const isTransient = TRANSIENT_PATTERNS.some((p) => message.includes(p));

      // Non-transient error — fail immediately, no point retrying
      if (!isTransient) throw err;

      attempt++;
      if (attempt > maxRetries) {
        console.error(`❌  [Retry] Exceeded ${maxRetries} retries. Last error: ${err.message}`);
        throw err;
      }

      const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.warn(
        `⚠️   [Retry] Transient error on attempt ${attempt}/${maxRetries}: ${err.message.slice(0, 80)}`
      );
      console.warn(`     Waiting ${delayMs / 1000}s before retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

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

  const response = await generateContentWithRetry({
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
          required: ['rank', 'name', 'niche', 'sourcePrice', 'retailPrice', 'margin', 'marginVal', 'trendScore', 'supplierHint', 'reasonToSell', 'tags', 'sourceLink', 'imageUrl', 'trendTrigger'],
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
            imageUrl: {
              type: Type.STRING,
              description: 'A high-quality, direct public product image or photo URL found during Phase 1 research. Must be a direct link ending in .jpg, .jpeg, .png, or .webp — not a search page or HTML page.',
            },
            trendTrigger: {
              type: Type.STRING,
              description: 'A detailed, context-rich explanation of why this product is trending. Connect it directly to real-world drivers such as Google Trends spikes, K-pop or social media aesthetics, upcoming seasonal holidays, global sports events, or TikTok viral hashtags.',
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
    `- imageUrl: extract a direct, publicly accessible product image URL from the research (must end in .jpg, .jpeg, .png, or .webp). Look for AliExpress product images, supplier listing photos, or clean product shots from review sites. If no direct image URL was found in the research, return an empty string ""`,
    `- trendTrigger: For each product, conduct a deep analysis of its real-world context. Identify the specific cultural, social, seasonal, or pop-culture event triggering the trend (for example: "Driven by the upcoming World Cup," "TikTok K-pop aesthetic trends," "Seasonal heatwaves," etc.). Explain this trigger in a professional, marketing-expert tone under the trendTrigger field.`,
    `- Output ONLY the JSON object. No markdown fences, no commentary.`,
    ``,
    `=== RESEARCH BRIEF ===`,
    researchText,
  ].join('\n');

  const response = await generateContentWithRetry({
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
//  SOURCE LINK SANITIZER
//  Runs after Phase 2. Guarantees every product has a live, evergreen URL.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a guaranteed-working AliExpress wholesale search URL for a product name.
 * Uses the standard /wholesale endpoint which never 404s.
 *
 * Example: "Self-Cooling Gel Pet Mat"
 *   → https://www.aliexpress.com/wholesale?SearchText=Self-Cooling+Gel+Pet+Mat
 */
function buildFallbackLink(productName) {
  const query = encodeURIComponent((productName || '').trim());
  return `https://www.aliexpress.com/wholesale?SearchText=${query}`;
}

/**
 * Decide whether a given URL is safe to keep as-is.
 *
 * STRICT MODE — only AliExpress URLs are trusted.
 * Returns true only when ALL of the following are satisfied:
 *   1. The URL is a non-empty string beginning with http:// or https://
 *   2. The hostname is exactly aliexpress.com, www.aliexpress.com,
 *      aliexpress.us, or www.aliexpress.us  (no other domains allowed)
 *   3. It is not a bare root path with no path/query content
 *   4. If it is a wholesale search URL, the SearchText param is non-empty
 *
 * Any URL from cjdropshipping.com, sellthetrend.com, tradelle.io, TikTok,
 * blogs, or any other domain is automatically rejected and replaced with
 * a clean AliExpress wholesale search URL built from the product name.
 */
const ALIEXPRESS_HOSTS = new Set([
  'aliexpress.com',
  'www.aliexpress.com',
  'aliexpress.us',
  'www.aliexpress.us',
]);

function isLinkReliable(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;

  // Reject specific item links or links that do not target wholesale search text
  if (trimmed.includes('/item/')) return false;
  if (!trimmed.includes('/wholesale?SearchText=')) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false; // Malformed URL
  }

  // ── Domain whitelist — only AliExpress allowed ────────────────────────────
  if (!ALIEXPRESS_HOSTS.has(parsed.hostname)) return false;

  // ── Reject bare domain root ───────────────────────────────────────────────
  if (parsed.pathname === '/' && !parsed.search) return false;

  // ── Reject empty wholesale SearchText param ───────────────────────────────
  if (parsed.pathname.includes('/wholesale')) {
    const searchText = (parsed.searchParams.get('SearchText') || '').trim();
    if (!searchText) return false;
  }

  return true;
}

/**
 * Iterate over all products in `data` and ensure every sourceLink is reliable.
 * Mutates the products array in place; returns a log of what was changed.
 */
function sanitizeSourceLinks(data) {
  const log = [];

  (data.products || []).forEach((product) => {
    const original = product.sourceLink;

    if (isLinkReliable(original)) {
      log.push({ rank: product.rank, name: product.name, action: 'kept', url: original });
      return;
    }

    // Generate the evergreen fallback
    const fallback = buildFallbackLink(product.name);
    product.sourceLink = fallback;

    log.push({
      rank:   product.rank,
      name:   product.name,
      action: original ? 'replaced' : 'generated',
      was:    original || '(none)',
      url:    fallback,
    });
  });

  return log;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ARCHIVE HELPERS — Dual history system for backtesting
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_PATH = path.resolve(__dirname, '../data/history.json');
const CSV_PATH     = path.resolve(__dirname, '../data/archive.csv');

const CSV_HEADERS = 'Date,Rank,Name,Niche,SourcePrice,RetailPrice,MarginPercent,MarginVal,TrendScore,SupplierHint,Tags,SourceLink,ImageUrl,TrendTrigger';

/**
 * Wrap a single CSV field value: always quote strings, escape internal
 * double-quotes by doubling them (RFC 4180 compliant).
 */
function csvField(value) {
  const str = (value == null ? '' : String(value)).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * Update data/history.json
 *
 * Loads the existing array (or initialises []), strips any entries whose
 * `date` matches TODAY (idempotent re-runs), stamps each product with
 * TODAY's date, appends, then writes back.
 */
function updateJsonHistory(products) {
  let history = [];

  if (fs.existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
      if (!Array.isArray(history)) history = [];
    } catch {
      console.warn('⚠️   [Archive] history.json was corrupt — reinitialising.');
      history = [];
    }
  }

  // Remove stale entries for today (handles re-runs on the same day)
  const before = history.length;
  history = history.filter((entry) => entry.date !== TODAY);
  if (history.length < before) {
    console.log(`    🗑️   Removed ${before - history.length} stale entries for ${TODAY} from history.json`);
  }

  // Stamp each product with today's date and append
  const stamped = products.map((p) => ({ date: TODAY, ...p }));
  history.push(...stamped);

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
  console.log(`    ✅  history.json — ${history.length} total entries (added ${stamped.length} for ${TODAY})`);
}

/**
 * Update data/archive.csv
 *
 * If the file doesn't exist, creates it with CSV_HEADERS.
 * Reads existing content, strips any rows that start with TODAY's date
 * (idempotent), appends 5 new rows, writes back.
 * All fields are double-quoted per RFC 4180 to handle commas in names/tags.
 */
function updateCsvArchive(products) {
  let lines;

  if (fs.existsSync(CSV_PATH)) {
    const raw = fs.readFileSync(CSV_PATH, 'utf-8').trimEnd();
    lines = raw.split('\n');
    // Ensure header is present (guard against an empty file)
    if (lines[0] !== CSV_HEADERS) lines.unshift(CSV_HEADERS);
  } else {
    lines = [CSV_HEADERS];
  }

  // Strip rows that belong to today (idempotent re-runs)
  // Each row's first field is a quoted date: "YYYY-MM-DD"
  const todayQuoted = csvField(TODAY);
  const before = lines.length;
  lines = lines.filter((line, i) => i === 0 || !line.startsWith(todayQuoted));
  if (lines.length < before) {
    console.log(`    🗑️   Removed ${before - lines.length} stale rows for ${TODAY} from archive.csv`);
  }

  // Append new rows
  const newRows = products.map((p) =>
    [
      csvField(TODAY),
      csvField(p.rank),
      csvField(p.name),
      csvField(p.niche),
      csvField(p.sourcePrice),
      csvField(p.retailPrice),
      csvField(p.margin),
      csvField(p.marginVal),
      csvField(p.trendScore),
      csvField(p.supplierHint),
      csvField((p.tags || []).join(', ')),
      csvField(p.sourceLink),
      csvField(p.imageUrl || ''),
      csvField(p.trendTrigger || ''),
    ].join(',')
  );
  lines.push(...newRows);

  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf-8');
  console.log(`    ✅  archive.csv  — ${lines.length - 1} total data rows (added ${newRows.length} for ${TODAY})`);
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

    // ── Sanitize source links (must run BEFORE write) ─────────────────────────
    console.log('\n🔗  [Link Sanitizer] Validating source links...');
    const linkLog = sanitizeSourceLinks(data);
    linkLog.forEach(({ rank, name, action, was, url }) => {
      if (action === 'kept') {
        console.log(`    ✅  #${rank} ${name} → kept: ${url}`);
      } else {
        console.log(`    ⚠️   #${rank} ${name} → ${action} (was: ${was})`);
        console.log(`         ↳ ${url}`);
      }
    });

    // ── Archive (history.json + archive.csv) ──────────────────────────────────
    console.log('\n🗂️   [Archive] Updating history files...');
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    updateJsonHistory(data.products);
    updateCsvArchive(data.products);

    // ── Write today.json ──────────────────────────────────────────────────────
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`\n💾  Written to: ${OUTPUT_PATH}`);

    // ── Summary table ─────────────────────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════');
    console.log(`  📊  TODAY'S TOP ${data.products.length} PRODUCTS (${COUNTRY})`);
    console.log('════════════════════════════════════════════════════════');
    data.products.forEach((p) => {
      const pad    = String(p.rank).padStart(2, ' ');
      const name   = (p.name || '').padEnd(38, ' ').slice(0, 38);
      const link   = (p.sourceLink || '').slice(0, 60);
      console.log(
        `  ${pad}. ${name}  |  src $${String(p.sourcePrice).padStart(5)}  ret $${String(p.retailPrice).padStart(6)}  ${p.margin.padStart(4)} margin  score ${p.trendScore}`
      );
      console.log(`      🔗  ${link}`);
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
