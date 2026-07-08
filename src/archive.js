/**
 * src/archive.js
 *
 * Archive browser — reads history.json (bundled by Parcel at build time),
 * groups products by date descending, renders a searchable timeline.
 */

import historyData from '../data/history.json';

// ─── DOM Helpers ──────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// ─── Date Formatter ───────────────────────────────────────────────────────────

/** '2026-07-09' → 'Wednesday, July 9, 2026' */
function formatDateHeading(isoDate) {
  // Parse as local date to avoid UTC off-by-one
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ─── Group by date (descending) ───────────────────────────────────────────────

function groupByDate(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = entry.date || 'Unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  // Sort dates descending (newest first)
  return new Map([...map.entries()].sort((a, b) => b[0].localeCompare(a[0])));
}

// ─── Margin helper ────────────────────────────────────────────────────────────

function parseMarginNum(product) {
  const fromStr = parseFloat(product.margin);
  if (!isNaN(fromStr)) return fromStr;
  if (product.retailPrice && product.marginVal != null) {
    return Math.round((product.marginVal / product.retailPrice) * 100);
  }
  return 0;
}

// ─── Compact Card Renderer ────────────────────────────────────────────────────

function renderCompactCard(product, dateIndex, cardIndex) {
  const delay = (dateIndex * 50) + (cardIndex * 80);
  const isTop = product.rank <= 2;
  const marginLabel = product.margin || product.estimatedMargin || '—';
  const reason = product.reasonToSell || product.reason || '';

  const hasPricing = product.sourcePrice != null && product.retailPrice != null;
  const pricingHtml = hasPricing ? `
      <div class="card-pricing">
        <span class="price-pill price-source" title="Source price">
          🏷️ Source&nbsp;<strong>$${Number(product.sourcePrice).toFixed(2)}</strong>
        </span>
        <span class="price-arrow">→</span>
        <span class="price-pill price-retail" title="Retail price">
          🛒 Retail&nbsp;<strong>$${Number(product.retailPrice).toFixed(2)}</strong>
        </span>
      </div>` : '';

  const hasLink = product.sourceLink && product.sourceLink.startsWith('http');
  const linkHtml = hasLink ? `
      <a class="source-link" href="${escHtml(product.sourceLink)}" target="_blank" rel="noopener noreferrer"
         aria-label="View supplier listing for ${escHtml(product.name)}">
        🔗 View Supplier
      </a>` : '';

  const tagsHtml = (product.tags || [])
    .map(t => `<span class="tag">#${escHtml(t)}</span>`)
    .join('');

  const card = document.createElement('article');
  card.className = 'product-card archive-card';
  card.style.animationDelay = `${delay}ms`;
  card.setAttribute('aria-label', `Rank ${product.rank}: ${product.name}`);
  // Store searchable text for filtering
  card.dataset.search = [
    product.name, product.niche, ...(product.tags || []),
  ].join(' ').toLowerCase();

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
        ${linkHtml}
      </div>

      <div class="card-meta">
        <span class="margin-pill" title="Gross profit margin">📈 ${escHtml(marginLabel)}</span>
        <div class="trend-score-wrap">
          <div class="trend-label">Trend Score</div>
          <div class="trend-score">${product.trendScore ?? '—'}</div>
          <div class="trend-bar"
               role="progressbar"
               aria-valuenow="${product.trendScore}"
               aria-valuemin="0"
               aria-valuemax="100"
               aria-label="Trend score ${product.trendScore} out of 100">
            <div class="trend-fill" style="width:0%" data-target="${product.trendScore ?? 0}%"></div>
          </div>
        </div>
        <p class="supplier-hint">🏭 <strong>${escHtml(product.supplierHint || '')}</strong></p>
      </div>
    </div>
  `;

  // Animate trend bar after paint
  requestAnimationFrame(() => {
    setTimeout(() => {
      const fill = card.querySelector('.trend-fill');
      if (fill) fill.style.width = fill.dataset.target;
    }, delay + 50);
  });

  return card;
}

// ─── Timeline Renderer ────────────────────────────────────────────────────────

/**
 * Renders the full timeline into #archive-timeline.
 * @param {Map<string, object[]>} grouped - Date → products map (descending)
 */
function renderTimeline(grouped) {
  const timeline = $('archive-timeline');
  timeline.innerHTML = '';

  if (grouped.size === 0) {
    timeline.innerHTML = `
      <div class="empty-state">
        <p>📭 No archived products yet.</p>
        <p style="font-size:.85rem;margin-top:.5rem;opacity:.7">
          Run <code>npm run analyze</code> to generate your first report.
        </p>
      </div>`;
    return;
  }

  let dateIdx = 0;
  for (const [date, products] of grouped) {
    const section = document.createElement('section');
    section.className = 'timeline-section';
    section.dataset.date = date;

    // Sort products by rank within each date
    const sorted = [...products].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

    const heading = document.createElement('div');
    heading.className = 'timeline-heading';
    heading.innerHTML = `
      <h2 class="timeline-date">${escHtml(formatDateHeading(date))}</h2>
      <span class="timeline-count">${sorted.length} product${sorted.length !== 1 ? 's' : ''}</span>
    `;
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'archive-grid';

    sorted.forEach((product, cardIdx) => {
      grid.appendChild(renderCompactCard(product, dateIdx, cardIdx));
    });

    section.appendChild(grid);
    timeline.appendChild(section);
    dateIdx++;
  }
}

// ─── Live Search Filter ───────────────────────────────────────────────────────

function applyFilter(query) {
  const q = query.trim().toLowerCase();
  const sections = document.querySelectorAll('.timeline-section');
  let totalVisible = 0;

  sections.forEach((section) => {
    const cards = section.querySelectorAll('.archive-card');
    let sectionVisible = 0;

    cards.forEach((card) => {
      const matches = !q || card.dataset.search.includes(q);
      card.style.display = matches ? '' : 'none';
      if (matches) sectionVisible++;
    });

    // Hide entire date section if none of its cards match
    section.style.display = sectionVisible > 0 ? '' : 'none';
    totalVisible += sectionVisible;
  });

  // Update result count badge
  const countEl = $('search-count');
  if (countEl) {
    countEl.textContent = q
      ? `${totalVisible} result${totalVisible !== 1 ? 's' : ''}`
      : '';
  }
}

// ─── Main Initializer ─────────────────────────────────────────────────────────

function initArchive() {
  const timeline = $('archive-timeline');

  try {
    const entries = Array.isArray(historyData) ? historyData : [];

    if (entries.length === 0) {
      timeline.innerHTML = `
        <div class="empty-state">
          <p>📭 No archived products yet.</p>
          <p style="font-size:.85rem;margin-top:.5rem;opacity:.7">
            Run <code>npm run analyze</code> to generate your first report.
          </p>
        </div>`;
      return;
    }

    const grouped = groupByDate(entries);
    renderTimeline(grouped);

    // Wire up live search
    const searchInput = $('archive-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => applyFilter(e.target.value));
      // Focus search on load for power users
      searchInput.focus();
    }

  } catch (err) {
    console.error('Archive init error:', err);
    timeline.innerHTML = `
      <div class="error-state" role="alert">
        <p>⚠️ Could not load archive data.</p>
        <p style="font-size:.85rem;margin-top:.5rem;opacity:.7">${escHtml(err.message)}</p>
      </div>`;
  }
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initArchive);
} else {
  initArchive();
}
