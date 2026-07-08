/**
 * src/archive.js
 *
 * Archive browser — reads history.json (bundled by Parcel at build time),
 * groups products by date, renders a scalable, searchable, and sortable timeline.
 */

import historyData from '../data/history.json';

// ─── State Management ─────────────────────────────────────────────────────────

let currentQuery = '';
let currentSort = 'date-desc';
let visibleGroupsCount = 3; // Batch size: render 3 dates (15 products) at a time
let groupedDates = []; // Active array of [date, products[]] after filter/sort
let observer; // IntersectionObserver for infinite scroll

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
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ─── Margin Helper ────────────────────────────────────────────────────────────

function parseMarginNum(product) {
  const fromStr = parseFloat(product.margin);
  if (!isNaN(fromStr)) return fromStr;
  if (product.retailPrice && product.marginVal != null) {
    return Math.round((product.marginVal / product.retailPrice) * 100);
  }
  return 0;
}

// ─── Card Renderer ────────────────────────────────────────────────────────────

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

// ─── Scalable Chunk Rendering ─────────────────────────────────────────────────

function renderTimelineBatch() {
  const timeline = $('archive-timeline');

  // If resetting to first batch, clear timeline
  if (visibleGroupsCount === 3) {
    timeline.innerHTML = '';
  } else {
    // Remove previous loader sentinel
    const oldSentinel = $('timeline-sentinel');
    if (oldSentinel) oldSentinel.remove();
  }

  if (groupedDates.length === 0) {
    timeline.innerHTML = `
      <div class="empty-state">
        <p>📭 No archived products match your filters.</p>
      </div>`;
    return;
  }

  // Slice current batch of date groups
  const batch = groupedDates.slice(visibleGroupsCount - 3, visibleGroupsCount);

  batch.forEach(([date, products], batchIdx) => {
    const dateIdx = (visibleGroupsCount - 3) + batchIdx;

    const section = document.createElement('section');
    section.className = 'timeline-section';
    section.dataset.date = date;

    const heading = document.createElement('div');
    heading.className = 'timeline-heading';
    heading.innerHTML = `
      <h2 class="timeline-date">${escHtml(formatDateHeading(date))}</h2>
      <span class="timeline-count">${products.length} product${products.length !== 1 ? 's' : ''}</span>
    `;
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'archive-grid';

    products.forEach((product, cardIdx) => {
      grid.appendChild(renderCompactCard(product, dateIdx, cardIdx));
    });

    section.appendChild(grid);
    timeline.appendChild(section);
  });

  // Setup Observer for infinite loading if more groups exist
  if (visibleGroupsCount < groupedDates.length) {
    const sentinel = document.createElement('div');
    sentinel.id = 'timeline-sentinel';
    sentinel.style.height = '40px';
    sentinel.style.display = 'flex';
    sentinel.style.alignItems = 'center';
    sentinel.style.justify = 'center';
    sentinel.innerHTML = '<div class="spinner" style="width:24px;height:24px;margin:0"></div>';
    timeline.appendChild(sentinel);

    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        visibleGroupsCount += 3;
        renderTimelineBatch();
      }
    }, { rootMargin: '200px' });
    observer.observe(sentinel);
  }
}

// ─── Filter & Sort Processing ─────────────────────────────────────────────────

function processAndRender() {
  const q = currentQuery.trim().toLowerCase();

  // 1. Filter flat entries array
  const filtered = historyData.filter((p) => {
    if (!q) return true;
    const name = (p.name || '').toLowerCase();
    const niche = (p.niche || '').toLowerCase();
    const tags = (p.tags || []).join(' ').toLowerCase();
    const date = (p.date || '').toLowerCase();
    return name.includes(q) || niche.includes(q) || tags.includes(q) || date.includes(q);
  });

  // Update count indicator
  filteredCount = filtered.length;
  const countEl = $('search-count');
  if (countEl) {
    countEl.textContent = q ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''}` : '';
  }

  // 2. Group filtered entries by date
  const groupsMap = new Map();
  for (const p of filtered) {
    const key = p.date || 'Unknown';
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(p);
  }

  groupedDates = Array.from(groupsMap.entries());

  // 3. Sort products within each date group
  groupedDates.forEach(([date, products]) => {
    products.sort((a, b) => {
      if (currentSort === 'revenue-desc') {
        return (b.marginVal ?? 0) - (a.marginVal ?? 0);
      } else if (currentSort === 'margin-desc') {
        return parseMarginNum(b) - parseMarginNum(a);
      } else if (currentSort === 'price-desc') {
        return (b.retailPrice ?? 0) - (a.retailPrice ?? 0);
      } else if (currentSort === 'demand-desc') {
        return (b.trendScore ?? 0) - (a.trendScore ?? 0);
      } else {
        // Default ranking sorting
        return (a.rank ?? 99) - (b.rank ?? 99);
      }
    });
  });

  // 4. Sort the date groups themselves
  groupedDates.sort((a, b) => {
    const dateA = a[0];
    const dateB = b[0];

    if (currentSort === 'date-asc') {
      return dateA.localeCompare(dateB);
    } else if (currentSort === 'date-desc') {
      return dateB.localeCompare(dateA);
    } else {
      // Sort dates by their top performing product's metric value
      const getMaxMetric = (products) => {
        return Math.max(...products.map(p => {
          if (currentSort === 'revenue-desc') return p.marginVal ?? 0;
          if (currentSort === 'margin-desc') return parseMarginNum(p);
          if (currentSort === 'price-desc') return p.retailPrice ?? 0;
          if (currentSort === 'demand-desc') return p.trendScore ?? 0;
          return 0;
        }));
      };
      return getMaxMetric(b[1]) - getMaxMetric(a[1]);
    }
  });

  // Reset pagination to first batch and render
  visibleGroupsCount = 3;
  renderTimelineBatch();
}

// ─── Main Initializer ─────────────────────────────────────────────────────────

let filteredCount = 0;

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

    processAndRender();

    // Wire up search events
    const searchInput = $('archive-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        currentQuery = e.target.value;
        processAndRender();
      });
      searchInput.focus();
    }

    // Wire up sort events
    const sortSelect = $('archive-sort');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        currentSort = e.target.value;
        processAndRender();
      });
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
