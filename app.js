(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const STORAGE = {
    theme: 'position-radar:theme',
    favorites: 'position-radar:favorites',
    filters: 'position-radar:filters',
    rank: 'position-radar:rank-type',
    cache: 'position-radar:last-state'
  };
  const RANK_LABELS = {
    composite: '综合排序', yieldRatio: '收益率', pnl: '收益额', winRatio: '胜率',
    aum: '带单规模', traderFollowerLimit: '跟单人数', followTotalPnl: '跟单用户收益', all: '所有交易员'
  };
  const state = {
    data: null,
    enriched: [],
    loading: true,
    refreshing: false,
    lastSuccessAt: 0,
    latency: 0,
    controller: null,
    timer: null,
    rankType: 'composite',
    filters: { query: '', symbol: 'all', direction: 'all', risk: 'all', position: 'all', sort: 'risk', favoritesOnly: false },
    favorites: new Set(),
    previous: new Map()
  };

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const el = {};

  function cacheElements() {
    Object.assign(el, {
      html: document.documentElement,
      connection: $('#connection-status'), refreshTime: $('#refresh-time'), refresh: $('#manual-refresh'),
      banner: $('#status-banner'), bannerText: $('#status-banner-text'), retry: $('#retry-button'),
      list: $('#account-list'), empty: $('#empty-state'), resultCount: $('#result-count'),
      rankSelect: $('#rank-type'),
      filterForm: $('#filter-form'), desktopFilters: $('#desktop-filters'), filterDialog: $('#filter-dialog'),
      mobileFilterContent: $('#mobile-filter-content'), openFilters: $('#open-filters'), activeFilterCount: $('#active-filter-count'),
      detailDialog: $('#detail-dialog'), dialogTitle: $('#dialog-title'), dialogContent: $('#dialog-content')
    });
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function numeric(value) {
    const number = Number.parseFloat(String(value ?? '').replace(/[$,%万\s]/g, ''));
    return Number.isFinite(number) ? number : 0;
  }

  const money = value => {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    const sign = n < 0 ? '−' : '';
    if (abs >= 1e8) return `${sign}$${(abs / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4) return `${sign}$${(abs / 1e4).toFixed(2)}万`;
    return `${sign}$${abs.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  };

  function riskForTrader(trader) {
    if (!trader.hasPosition || !trader.positions?.length) {
      return { score: 0, level: 'stable', label: '平稳', reasons: ['当前空仓'] };
    }
    const positions = trader.positions;
    const maxLeverage = Math.max(...positions.map(p => numeric(p.lever)));
    const worstPnl = Math.min(...positions.map(p => numeric(p.uplRate)));
    const marginRates = positions.map(p => numeric(p.mgnRate)).filter(Boolean);
    const minMarginRate = marginRates.length ? Math.min(...marginRates) : Infinity;
    const distances = positions.map(p => {
      const mark = numeric(p.markPx), liq = numeric(p.liqPx);
      return mark > 0 && liq > 0 ? Math.abs(mark - liq) / mark : Infinity;
    }).filter(Number.isFinite);
    const liqDistance = distances.length ? Math.min(...distances) : Infinity;
    const dangerous = positions.some(p => p.danger);
    let score = 0;
    const reasons = [];

    if (maxLeverage >= 100) { score += 35; reasons.push(`最高 ${maxLeverage}x 杠杆`); }
    else if (maxLeverage >= 50) { score += 28; reasons.push(`最高 ${maxLeverage}x 杠杆`); }
    else if (maxLeverage >= 20) { score += 20; reasons.push(`最高 ${maxLeverage}x 杠杆`); }
    else if (maxLeverage >= 10) { score += 12; reasons.push(`最高 ${maxLeverage}x 杠杆`); }
    else if (maxLeverage >= 5) { score += 6; reasons.push(`最高 ${maxLeverage}x 杠杆`); }

    if (worstPnl <= -200) { score += 30; reasons.push(`最差收益率 ${worstPnl.toFixed(0)}%`); }
    else if (worstPnl <= -100) { score += 24; reasons.push(`最差收益率 ${worstPnl.toFixed(0)}%`); }
    else if (worstPnl <= -50) { score += 18; reasons.push(`最差收益率 ${worstPnl.toFixed(0)}%`); }
    else if (worstPnl <= -20) { score += 10; reasons.push(`最差收益率 ${worstPnl.toFixed(0)}%`); }

    if (minMarginRate < 100) { score += 30; reasons.push(`保证金率 ${minMarginRate.toFixed(0)}%`); }
    else if (minMarginRate < 200) { score += 24; reasons.push(`保证金率 ${minMarginRate.toFixed(0)}%`); }
    else if (minMarginRate < 500) { score += 16; reasons.push(`保证金率 ${minMarginRate.toFixed(0)}%`); }
    else if (minMarginRate < 1000) { score += 8; reasons.push(`保证金率 ${minMarginRate.toFixed(0)}%`); }

    if (liqDistance < .05) { score += 35; reasons.push(`距爆仓价 ${(liqDistance * 100).toFixed(1)}%`); }
    else if (liqDistance < .1) { score += 26; reasons.push(`距爆仓价 ${(liqDistance * 100).toFixed(1)}%`); }
    else if (liqDistance < .2) { score += 16; reasons.push(`距爆仓价 ${(liqDistance * 100).toFixed(1)}%`); }
    if (dangerous) { score += 30; reasons.push('接口标记危险仓位'); }

    score = Math.min(100, score);
    const [level, label] = score >= 60 ? ['critical', '紧急'] : score >= 38 ? ['elevated', '偏高'] : score >= 18 ? ['guarded', '关注'] : ['stable', '平稳'];
    if (!reasons.length) reasons.push('杠杆、亏损与爆仓距离均在平稳区间');
    return { score, level, label, reasons };
  }

  function validatePayload(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) throw new Error('数据格式不完整：缺少 items 数组');
    payload.items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || !Array.isArray(item.positions)) throw new Error(`数据格式不完整：账户 ${index + 1}`);
    });
    return payload;
  }

  function endpoint() {
    if (new URLSearchParams(location.search).get('demo') === '1') return './status.sample.json';
    const url = new URL(CONFIG.STATUS_PATH || '/api/status', `${CONFIG.API_BASE_URL || location.origin}/`);
    url.searchParams.set('rank_type', state.rankType);
    return url.href;
  }

  const cacheKey = () => `${STORAGE.cache}:${state.rankType}`;

  async function loadData({ manual = false } = {}) {
    if (state.refreshing) state.controller?.abort();
    state.refreshing = true;
    state.controller = new AbortController();
    el.refresh.disabled = true;
    setConnection('loading', manual ? '正在刷新' : '正在同步');
    const timeout = setTimeout(() => state.controller.abort(), CONFIG.REQUEST_TIMEOUT_MS || 12000);
    const started = performance.now();
    let warming = false;
    try {
      const response = await fetch(endpoint(), { cache: 'no-store', credentials: 'omit', signal: state.controller.signal, headers: { Accept: 'application/json' } });
      if (response.status === 202) {
        warming = true;
        setConnection('loading', '正在准备分类');
        showBanner(`${RANK_LABELS[state.rankType]}首次载入中，服务器正在整理对应交易员列表。`, false);
        return;
      }
      if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}`);
      const payload = validatePayload(await response.json());
      state.latency = Math.round(performance.now() - started);
      applyPayload(payload);
      state.lastSuccessAt = Date.now();
      localStorage.setItem(cacheKey(), JSON.stringify({ savedAt: state.lastSuccessAt, payload }));
      hideBanner();
      setConnection('online', `${state.latency}ms`);
    } catch (error) {
      if (error.name !== 'AbortError' || !state.data) handleFetchFailure(error);
    } finally {
      clearTimeout(timeout);
      state.refreshing = false;
      el.refresh.disabled = false;
      if (warming) {
        state.loading = true;
        clearTimeout(state.timer);
        state.timer = setTimeout(() => loadData(), 2000);
      } else {
        state.loading = false;
        scheduleNext();
      }
    }
  }

  function applyPayload(payload, { cached = false } = {}) {
    const old = new Map((state.data?.items || []).map(item => [item.uniqueName, item]));
    state.previous = old;
    state.data = payload;
    state.enriched = payload.items.map(item => ({ ...item, risk: riskForTrader(item) }));
    populateSymbols();
    renderDashboard();
    renderAccounts();
    if (cached) showBanner('正在显示上次保存的数据，后台正在重新连接。', true);
  }

  function handleFetchFailure(error) {
    const isOffline = !navigator.onLine;
    if (!state.data) {
      const cached = readJSON(cacheKey(), null);
      if (cached?.payload) {
        state.lastSuccessAt = cached.savedAt || 0;
        applyPayload(cached.payload, { cached: true });
      } else {
        el.list.innerHTML = '';
        el.empty.hidden = false;
        el.empty.querySelector('h3').textContent = '实时数据暂未接通';
        el.empty.querySelector('p').textContent = '检查 API 域名、HTTPS 与跨域配置后重试。';
      }
    }
    setConnection('offline', isOffline ? '设备离线' : '连接中断');
    showBanner(`${isOffline ? '当前离线' : '实时接口连接失败'}：${error.message || '请求超时'}。页面保留最近一次数据。`, true);
  }

  function scheduleNext() {
    clearTimeout(state.timer);
    const serverInterval = Number(state.data?.update_interval_seconds) || CONFIG.MIN_POLL_SECONDS || 10;
    const base = Math.max(CONFIG.MIN_POLL_SECONDS || 10, serverInterval) * 1000;
    const hiddenFactor = document.hidden ? 6 : 1;
    const jitter = .9 + Math.random() * .2;
    state.timer = setTimeout(() => loadData(), base * hiddenFactor * jitter);
  }

  function setConnection(mode, text) {
    el.connection.className = `connection ${mode === 'online' ? 'online' : mode === 'offline' ? 'offline' : ''}`;
    $('span', el.connection).textContent = text;
  }
  function showBanner(text, retry = false) { el.bannerText.textContent = text; el.retry.hidden = !retry; el.banner.hidden = false; }
  function hideBanner() { el.banner.hidden = true; }

  function renderDashboard() {
    const items = state.enriched;
    const active = items.filter(x => x.hasPosition);
    const positions = items.flatMap(x => x.positions || []);
    const riskCount = items.filter(x => ['critical', 'elevated'].includes(x.risk.level)).length;
    const aum = items.reduce((sum, x) => sum + (Number(x.traderAum) || 0), 0);
    const notional = positions.reduce((sum, x) => sum + (Number(x.notionalValue) || 0), 0);
    $('#metric-risk').textContent = riskCount;
    $('#metric-risk-note').textContent = riskCount ? `${items.filter(x => x.risk.level === 'critical').length} 个紧急 · ${items.filter(x => x.risk.level === 'elevated').length} 个偏高` : '暂无高风险信号';
    $('#metric-accounts').textContent = items.length;
    $('#metric-active').textContent = `${active.length} 个持仓中`;
    $('#metric-aum').textContent = money(aum);
    $('#metric-notional').textContent = money(notional);
    $('#metric-positions').textContent = `${positions.length} 个公开仓位`;
    el.refreshTime.textContent = state.data.last_refresh_time || '时间未知';
    el.refreshTime.dateTime = String(state.data.last_refresh_time || '').replace(' ', 'T');

    const liq = state.data.recent_liq_panel || {};
    $('#liq-row').innerHTML = ['btc', 'eth', 'sol', 'okx'].map(symbol => `<span><b>${symbol.toUpperCase()}</b><em>${escapeHTML(liq[symbol] || '—')}</em></span>`).join('');
    const market = state.data.market_game || {};
    const longRatio = Math.max(0, Math.min(1, Number(market.long_ratio) || 0));
    const shortRatio = Math.max(0, Math.min(1, Number(market.short_ratio) || 0));
    $('#long-label').textContent = `多头 ${(longRatio * 100).toFixed(1)}% · ${market.long || '—'}`;
    $('#short-label').textContent = `空头 ${(shortRatio * 100).toFixed(1)}% · ${market.short || '—'}`;
    $('#balance-total').textContent = `总持仓 ${money((Number(market.long_value) || 0) + (Number(market.short_value) || 0))}`;
    $('#long-bar').style.width = `${longRatio * 100}%`;
    $('#short-bar').style.width = `${shortRatio * 100}%`;
    $('#balance-needle').style.left = `${longRatio * 100}%`;
    $('.balance-track').setAttribute('aria-label', `多头 ${(longRatio * 100).toFixed(1)}%，空头 ${(shortRatio * 100).toFixed(1)}%`);
  }

  function currentItems() {
    const f = state.filters;
    const q = f.query.trim().toLowerCase();
    let items = state.enriched.filter(item => {
      const symbols = (item.positions || []).map(p => p.symbolBase?.toLowerCase());
      if (q && !String(item.name).toLowerCase().includes(q) && !symbols.some(s => s?.includes(q))) return false;
      if (f.symbol !== 'all' && !symbols.includes(f.symbol.toLowerCase())) return false;
      if (f.direction !== 'all' && !(item.positions || []).some(p => p.direction === f.direction)) return false;
      if (f.risk !== 'all' && item.risk.level !== f.risk) return false;
      if (f.position === 'active' && !item.hasPosition) return false;
      if (f.position === 'empty' && item.hasPosition) return false;
      if (f.favoritesOnly && !state.favorites.has(item.uniqueName)) return false;
      return true;
    });
    const numberFor = (item, key) => Number(item.position?.[key]) || 0;
    items.sort((a, b) => {
      const favoriteDelta = Number(state.favorites.has(b.uniqueName)) - Number(state.favorites.has(a.uniqueName));
      if (favoriteDelta) return favoriteDelta;
      if (f.sort === 'pnl-desc') return numberFor(b, 'uplRate') - numberFor(a, 'uplRate');
      if (f.sort === 'pnl-asc') return numberFor(a, 'uplRate') - numberFor(b, 'uplRate');
      if (f.sort === 'notional') return numberFor(b, 'notionalValue') - numberFor(a, 'notionalValue');
      if (f.sort === 'aum') return (b.traderAum || 0) - (a.traderAum || 0);
      if (f.sort === 'name') return String(a.name).localeCompare(String(b.name), 'zh-CN');
      return b.risk.score - a.risk.score;
    });
    return items;
  }

  function renderSkeletons() {
    const template = $('#skeleton-template');
    el.list.innerHTML = '';
    for (let i = 0; i < 4; i++) el.list.append(template.content.cloneNode(true));
  }

  function deltaFor(item, key) {
    const before = state.previous.get(item.uniqueName)?.position?.[key];
    const after = item.position?.[key];
    if (before == null || after == null || numeric(before) === numeric(after)) return null;
    const diff = numeric(after) - numeric(before);
    return { direction: diff > 0 ? 'up' : 'down', text: `较上次 ${diff > 0 ? '↑' : '↓'} ${Math.abs(diff).toFixed(2)}${key === 'uplRate' ? 'pp' : ''}` };
  }

  function createCard(item) {
    const card = document.createElement('article');
    card.className = `account-card risk-${item.risk.level}${item.hasPosition ? '' : ' empty-account'}`;
    card.dataset.id = item.uniqueName;
    const p = item.position;
    const pnl = p ? numeric(p.uplRate) : 0;
    const deltaPnl = deltaFor(item, 'uplRate');
    const deltaNotional = deltaFor(item, 'notionalValue');
    const favorite = state.favorites.has(item.uniqueName);
    card.innerHTML = `
      <div class="card-head">
        <div class="identity"><h3 title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</h3><p>${escapeHTML(item.platform || '—')} · ${item.positions.length} 个仓位</p></div>
        <button class="favorite-button" type="button" data-action="favorite" aria-label="${favorite ? '取消收藏' : '收藏'} ${escapeHTML(item.name)}" aria-pressed="${favorite}">${favorite ? '★' : '☆'}</button>
      </div>
      <div class="card-tags">
        ${p ? `<span class="tag direction-${p.direction === '空' ? 'short' : 'long'}">${escapeHTML(p.direction)} ${escapeHTML(p.lever)}x</span><span class="tag">${escapeHTML(p.symbolBase)}</span>` : '<span class="tag">当前空仓</span>'}
        <span class="tag risk-chip">${item.risk.label} · ${item.risk.score}</span>
      </div>
      <div class="metric-pair">
        <div class="metric-block"><span>收益率</span><strong class="${pnl >= 0 ? 'is-positive' : 'is-negative'} ${deltaPnl ? `value-flash-${deltaPnl.direction}` : ''}">${p ? escapeHTML(p.uplRate) : '—'}</strong><small class="delta ${deltaPnl ? `changed-${deltaPnl.direction}` : ''}">${deltaPnl ? deltaPnl.text : '本轮暂无变化'}</small></div>
        <div class="metric-block"><span>主仓持仓值</span><strong class="${deltaNotional ? `value-flash-${deltaNotional.direction}` : ''}">${p ? money(p.notionalValue) : '—'}</strong><small class="delta ${deltaNotional ? `changed-${deltaNotional.direction}` : ''}">${deltaNotional ? deltaNotional.text : `AUM ${money(item.traderAum)}`}</small></div>
      </div>
      <div class="risk-line"><span>风险强度</span><div class="risk-meter" aria-hidden="true"><i style="width:${item.risk.score}%"></i></div><b>${item.risk.score}</b></div>
      <div class="card-foot"><span>${p ? `${escapeHTML(p.symbolBase)} 标记价 $${escapeHTML(p.markPx)}` : '等待下一次持仓信号'}</span><button class="details-button" type="button" data-action="detail">查看详情</button></div>
      ${item.error ? `<p class="error-note">数据提示：${escapeHTML(item.error)}</p>` : ''}`;
    return card;
  }

  function renderAccounts() {
    const items = currentItems();
    el.list.innerHTML = '';
    items.forEach(item => el.list.append(createCard(item)));
    el.list.setAttribute('aria-busy', 'false');
    el.empty.hidden = items.length > 0;
    el.resultCount.textContent = `${RANK_LABELS[state.rankType]} · 显示 ${items.length} / ${state.enriched.length} 个账户 · 风险评分为前端实时计算`;
    updateFilterCount();
  }

  function populateSymbols() {
    const select = $('#symbol-filter');
    const current = state.filters.symbol;
    const symbols = [...new Set(state.enriched.flatMap(x => x.positions || []).map(x => x.symbolBase).filter(Boolean))].sort();
    select.innerHTML = '<option value="all">全部币种</option>' + symbols.map(symbol => `<option value="${escapeHTML(symbol)}">${escapeHTML(symbol)}</option>`).join('');
    select.value = symbols.includes(current) ? current : 'all';
    state.filters.symbol = select.value;
  }

  function updateFilterCount() {
    const f = state.filters;
    const count = Number(Boolean(f.query)) + Number(f.symbol !== 'all') + Number(f.direction !== 'all') + Number(f.risk !== 'all') + Number(f.position !== 'all') + Number(f.sort !== 'risk') + Number(f.favoritesOnly);
    el.activeFilterCount.textContent = count;
    el.activeFilterCount.hidden = count === 0;
  }

  function persistPreferences() {
    localStorage.setItem(STORAGE.filters, JSON.stringify(state.filters));
    localStorage.setItem(STORAGE.favorites, JSON.stringify([...state.favorites]));
  }

  function syncFilterControls() {
    $('#search-input').value = state.filters.query;
    $('#symbol-filter').value = state.filters.symbol;
    $('#risk-filter').value = state.filters.risk;
    $('#position-filter').value = state.filters.position;
    $('#sort-filter').value = state.filters.sort;
    $('#favorites-only').checked = state.filters.favoritesOnly;
    $$('[data-filter="direction"]').forEach(button => button.classList.toggle('is-active', button.dataset.value === state.filters.direction));
    updateFilterCount();
  }

  function clearFilters() {
    state.filters = { query: '', symbol: 'all', direction: 'all', risk: 'all', position: 'all', sort: 'risk', favoritesOnly: false };
    syncFilterControls();
    persistPreferences();
    renderAccounts();
  }

  function openDetails(id) {
    const item = state.enriched.find(x => x.uniqueName === id);
    if (!item) return;
    el.dialogTitle.textContent = item.name;
    const total = (item.positions || []).reduce((sum, p) => sum + (Number(p.notionalValue) || 0), 0);
    const totalPnl = (item.positions || []).reduce((sum, p) => sum + numeric(p.upl), 0);
    el.detailDialog.className = `detail-dialog risk-${item.risk.level}`;
    el.dialogContent.innerHTML = `
      <div class="dialog-summary">
        <div class="dialog-stat"><span>风险评分</span><strong style="color:var(--risk-color)">${item.risk.score} · ${item.risk.label}</strong></div>
        <div class="dialog-stat"><span>全部持仓值</span><strong>${money(total)}</strong></div>
        <div class="dialog-stat"><span>未实现收益</span><strong class="${totalPnl >= 0 ? 'is-positive' : 'is-negative'}">${money(totalPnl)}</strong></div>
      </div>
      <div class="risk-explain"><strong>为什么是${item.risk.label}风险</strong><p>${escapeHTML(item.risk.reasons.join('；'))}。评分综合杠杆、亏损率、保证金率及可计算的爆仓距离，满分 100。</p></div>
      ${item.positions.length ? `<div class="positions-wrap"><table class="positions-table"><thead><tr><th>币种</th><th>方向</th><th>收益率</th><th>持仓值</th><th>开仓均价</th><th>标记价</th><th>爆仓价</th></tr></thead><tbody>${item.positions.map(p => `<tr><td>${escapeHTML(p.symbolBase)}</td><td class="${p.direction === '多' ? 'is-positive' : 'is-negative'}">${escapeHTML(p.dirLev)}</td><td class="${numeric(p.uplRate) >= 0 ? 'is-positive' : 'is-negative'}">${escapeHTML(p.uplRate)}</td><td>${money(p.notionalValue)}</td><td>$${escapeHTML(p.avgPx)}</td><td>$${escapeHTML(p.markPx)}</td><td>${p.liqPx === '--' ? '—' : `$${escapeHTML(p.liqPx)}`}</td></tr>`).join('')}</tbody></table></div>` : '<p>该账户当前没有公开持仓。</p>'}
      ${item.traderUrl ? `<a class="source-link" href="${escapeHTML(item.traderUrl)}" target="_blank" rel="noopener noreferrer">前往交易员公开页 ↗</a>` : ''}`;
    el.detailDialog.showModal();
  }

  function wireEvents() {
    $('#theme-toggle').addEventListener('click', toggleTheme);
    el.rankSelect.addEventListener('change', () => {
      if (!(el.rankSelect.value in RANK_LABELS) || el.rankSelect.value === state.rankType) return;
      state.rankType = el.rankSelect.value;
      localStorage.setItem(STORAGE.rank, state.rankType);
      state.data = null;
      state.enriched = [];
      state.previous = new Map();
      state.lastSuccessAt = 0;
      el.empty.hidden = true;
      el.list.setAttribute('aria-busy', 'true');
      el.resultCount.textContent = `正在载入${RANK_LABELS[state.rankType]}…`;
      renderSkeletons();
      loadData({ manual: true });
    });
    el.refresh.addEventListener('click', () => loadData({ manual: true }));
    el.retry.addEventListener('click', () => loadData({ manual: true }));
    $('#empty-clear').addEventListener('click', clearFilters);
    $('#clear-filters').addEventListener('click', clearFilters);
    el.filterForm.addEventListener('input', event => {
      if (event.target.id === 'search-input') state.filters.query = event.target.value;
      if (event.target.id === 'favorites-only') state.filters.favoritesOnly = event.target.checked;
      persistPreferences(); renderAccounts();
    });
    el.filterForm.addEventListener('change', event => {
      const map = { 'symbol-filter': 'symbol', 'risk-filter': 'risk', 'position-filter': 'position', 'sort-filter': 'sort' };
      if (map[event.target.id]) state.filters[map[event.target.id]] = event.target.value;
      persistPreferences(); renderAccounts();
    });
    el.filterForm.addEventListener('click', event => {
      const button = event.target.closest('[data-filter="direction"]');
      if (!button) return;
      state.filters.direction = button.dataset.value;
      syncFilterControls(); persistPreferences(); renderAccounts();
    });
    el.list.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      const card = event.target.closest('.account-card');
      if (!button || !card) return;
      if (button.dataset.action === 'detail') openDetails(card.dataset.id);
      if (button.dataset.action === 'favorite') {
        state.favorites.has(card.dataset.id) ? state.favorites.delete(card.dataset.id) : state.favorites.add(card.dataset.id);
        persistPreferences(); renderAccounts();
      }
    });
    $('[data-close-dialog]').addEventListener('click', () => el.detailDialog.close());
    el.detailDialog.addEventListener('click', event => { if (event.target === el.detailDialog) el.detailDialog.close(); });
    el.openFilters.addEventListener('click', openFilterDrawer);
    el.filterDialog.addEventListener('close', closeFilterDrawer);
    window.addEventListener('online', () => loadData({ manual: true }));
    window.addEventListener('offline', () => { setConnection('offline', '设备离线'); showBanner('当前离线，继续显示最近一次数据。', true); });
    document.addEventListener('visibilitychange', () => {
      clearTimeout(state.timer);
      if (document.hidden) scheduleNext(); else loadData();
    });
    setInterval(checkStaleness, 5000);
    window.addEventListener('error', event => console.error('[position-radar]', event.message, event.error));
    window.addEventListener('unhandledrejection', event => console.error('[position-radar]', event.reason));
  }

  function openFilterDrawer() {
    el.mobileFilterContent.append(el.filterForm);
    el.filterDialog.showModal();
    setTimeout(() => $('#search-input')?.focus(), 30);
  }
  function closeFilterDrawer() {
    el.desktopFilters.append(el.filterForm);
    el.openFilters.focus();
  }

  function checkStaleness() {
    if (!state.lastSuccessAt || !state.data) return;
    const seconds = Math.round((Date.now() - state.lastSuccessAt) / 1000);
    if (seconds > (CONFIG.STALE_AFTER_SECONDS || 45) && navigator.onLine) showBanner(`数据已 ${seconds} 秒未更新，正在等待下一次同步。`, true);
  }

  function toggleTheme() {
    const theme = el.html.dataset.theme === 'dark' ? 'light' : 'dark';
    el.html.dataset.theme = theme;
    localStorage.setItem(STORAGE.theme, theme);
    $('#theme-toggle').setAttribute('aria-label', `切换${theme === 'dark' ? '浅色' : '深色'}模式`);
    $('meta[name="theme-color"]').content = theme === 'dark' ? '#07152d' : '#f6f9fd';
  }

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }

  function restorePreferences() {
    const savedTheme = localStorage.getItem(STORAGE.theme);
    const theme = savedTheme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    el.html.dataset.theme = theme;
    state.favorites = new Set(readJSON(STORAGE.favorites, []));
    state.filters = { ...state.filters, ...readJSON(STORAGE.filters, {}) };
    const savedRank = localStorage.getItem(STORAGE.rank);
    state.rankType = savedRank && savedRank in RANK_LABELS ? savedRank : 'composite';
    el.rankSelect.value = state.rankType;
    syncFilterControls();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker:', error));
  }

  function init() {
    cacheElements();
    restorePreferences();
    wireEvents();
    renderSkeletons();
    registerServiceWorker();
    loadData();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
