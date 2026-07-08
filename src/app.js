/**
 * src/app.js
 *
 * Frontend dashboard — data is bundled at build time via Parcel's JSON import.
 * No runtime fetch() required. today.json is resolved statically by the bundler.
 */

import todayData from '../data/today.json';

// ─── DOM Helpers ──────────────────────────────────────────────────────────────

/** Safely escape a value to prevent XSS when inserting into innerHTML. */
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function $(id) { return document.getElementById(id); }

// ─── Stat Helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a margin string like "72%" → 72. Falls back to marginVal/retailPrice
 * calculation if the string is missing or unparseable.
 */
function parseMarginNum(product) {
  const fromStr = parseFloat(product.margin);
  if (!isNaN(fromStr)) return fromStr;
  if (product.retailPrice && product.marginVal != null) {
    return Math.round((product.marginVal / product.retailPrice) * 100);
  }
  return 0;
}

// ─── Card Renderer ────────────────────────────────────────────────────────────

function renderCard(container, product, index) {
  const delay = index * 110;
  const isTop = product.rank <= 2;

  // ── Price row — only shown when sourcePrice / retailPrice are present ───────
  const hasPricing = product.sourcePrice != null && product.retailPrice != null;
  const pricingHtml = hasPricing ? `
      <div class="card-pricing">
        <span class="price-pill price-source" title="AliExpress / CJ source price">
          🏷️ Source&nbsp;<strong>$${Number(product.sourcePrice).toFixed(2)}</strong>
        </span>
        <span class="price-arrow">→</span>
        <span class="price-pill price-retail" title="Retail selling price">
          🛒 Retail&nbsp;<strong>$${Number(product.retailPrice).toFixed(2)}</strong>
        </span>
      </div>` : '';

  // ── Source link — shown when present ─────────────────────────────────────────
  const hasLink = product.sourceLink && product.sourceLink.startsWith('http');
  const linkHtml = hasLink ? `
      <a class="source-link" href="${escHtml(product.sourceLink)}" target="_blank" rel="noopener noreferrer"
         aria-label="View supplier listing for ${escHtml(product.name)}">
        🔗 View Supplier
      </a>` : '';

  // ── Margin label — prefer `margin` string, fall back to `estimatedMargin` ───
  const marginLabel = product.margin || product.estimatedMargin || '—';

  // ── Tags ──────────────────────────────────────────────────────────────────────
  const tagsHtml = (product.tags || [])
    .map(t => `<span class="tag">#${escHtml(t)}</span>`)
    .join('');

  // ── reasonToSell (new schema) or legacy field ────────────────────────────────
  const reason = product.reasonToSell || product.reason || '';

  // ── Build card element ────────────────────────────────────────────────────────
  const card = document.createElement('article');
  card.className = 'product-card';
  card.style.animationDelay = `${delay}ms`;
  card.setAttribute('aria-label', `Rank ${product.rank}: ${product.name}`);

  card.innerHTML = `
    <div class="card-image-wrap">
      <img
        class="card-image"
        src="${escHtml(product.imageUrl || '')}"
        alt="${escHtml(product.name)}"
        loading="lazy"
        onload="this.classList.add('loaded')"
        onerror="this.onerror=null; this.src='https://images.unsplash.com/featured/600x400/?' + encodeURIComponent(this.alt);"
      />
    </div>

    <div class="card-content">
      <div class="card-rank ${isTop ? 'top' : ''}" aria-hidden="true">${String(product.rank).padStart(2, '0')}</div>

      <div class="card-body">
        <div class="card-header">
          <span class="card-name">${escHtml(product.name)}</span>
          <span class="niche-badge">${escHtml(product.niche)}</span>
        </div>
        ${reason ? `<p class="card-reason">${escHtml(reason)}</p>` : ''}
        ${pricingHtml}
        <div class="card-tags">${tagsHtml}</div>
        
        <!-- Highlighted AI Trend Trigger Badge -->
        ${product.trendTrigger ? `
          <div class="card-trigger-block">
            💡 <strong>AI Trend Trigger:</strong> ${escHtml(product.trendTrigger)}
          </div>
        ` : ''}
        
        ${linkHtml}
      </div>

      <div class="card-meta">
        <span class="margin-pill" title="Gross profit margin">📈 ${escHtml(marginLabel)}</span>
        <div class="trend-score-wrap">
          <div class="trend-label">Trend Score</div>
          <div class="trend-score">${product.trendScore}</div>
          <div class="trend-bar"
               role="progressbar"
               aria-valuenow="${product.trendScore}"
               aria-valuemin="0"
               aria-valuemax="100"
               aria-label="Trend score ${product.trendScore} out of 100">
            <div class="trend-fill" style="width:0%" data-target="${product.trendScore}%"></div>
          </div>
        </div>
        <p class="supplier-hint">🏭 <strong>${escHtml(product.supplierHint || '')}</strong></p>
      </div>
    </div>
  `;

  container.appendChild(card);

  // Animate the trend bar after the browser has painted the card
  requestAnimationFrame(() => {
    setTimeout(() => {
      const fill = card.querySelector('.trend-fill');
      if (fill) fill.style.width = fill.dataset.target;
    }, delay + 50);
  });
}


// ─── Main Initializer ─────────────────────────────────────────────────────────

function initDashboard() {
  const grid = $('products-grid');

  try {
    const data = todayData; // Bundled at build time — never null

    // ── Date badge ──────────────────────────────────────────────────────────────
    const dateEl = $('report-date');
    if (dateEl && data.generatedAt) {
      const d = new Date(data.generatedAt);
      dateEl.textContent = `📅 Report for ${d.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      })}`;
    }

    const products = data.products;

    if (!Array.isArray(products) || products.length === 0) {
      throw new Error('No products found in today.json.');
    }

    // ── Stats ────────────────────────────────────────────────────────────────────
    const margins   = products.map(p => parseMarginNum(p)).filter(n => n > 0);
    const avgMargin = margins.length
      ? (margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(0)
      : '—';
    const topScore  = Math.max(...products.map(p => p.trendScore ?? 0));

    const avgEl   = $('stat-avg-margin');
    const scoreEl = $('stat-top-score');
    const countEl = $('stat-products');

    if (avgEl)   avgEl.textContent   = `${avgMargin}%`;
    if (scoreEl) scoreEl.textContent = topScore;
    if (countEl) countEl.textContent = products.length;

    // ── Render cards ─────────────────────────────────────────────────────────────
    grid.innerHTML = '';
    products.forEach((product, index) => renderCard(grid, product, index));

  } catch (err) {
    console.error('Dashboard init error:', err);
    grid.innerHTML = `
      <div class="error-state" role="alert">
        <p>⚠️ Could not render today's product data.</p>
        <p style="font-size:.85rem;margin-top:.5rem;opacity:.7">${escHtml(err.message)}</p>
      </div>`;
  }
}

// Run after DOM is ready (Parcel executes modules deferred, but guard anyway)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboard);
} else {
  initDashboard();
}
