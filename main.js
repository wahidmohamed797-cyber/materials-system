const THEME_KEY = 'raw-materials-theme';
const NOTIFICATIONS_KEY = 'raw-materials-low-stock-notifications';
const NOTIFICATIONS_SEEN_KEY = 'raw-materials-seen-stock-alerts';
const WEIGHT_UNITS = { g: 1, kg: 1000, ton: 1000000 };
const UNIT_LABELS = { g: 'جرام', kg: 'كيلو', ton: 'طن', bag: 'شكارة' };
const MOVEMENT_LABELS = {
	opening: 'رصيد افتتاحي', inbound: 'إضافة كمية', production_issue: 'صرف للإنتاج',
	return: 'مرتجع من الإنتاج', adjustment_in: 'تسوية زيادة', adjustment_out: 'تسوية نقص',
	transfer_in: 'تحويل وارد', transfer_out: 'تحويل صادر'
};

const app = document.querySelector('#app');
const state = { client: null, session: null, page: 'home', warehouseId: null, warehousesExpanded: false, warehouses: [], materials: [], movements: [], charts: [], reportDate: today(), busy: false };

function today() { return localDateKey(new Date()); }
function localDateKey(value) {
	const date = value instanceof Date ? value : new Date(value);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}
function dateInputTimestamp(value) {
	const [year, month, day] = value.split('-').map(Number);
	return new Date(year, month - 1, day, 12).toISOString();
}
function escapeHtml(value = '') {
	return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function formatNumber(value, maximumFractionDigits = 2) {
	return new Intl.NumberFormat('ar-EG', { maximumFractionDigits }).format(Number(value || 0));
}
function formatDate(value) {
	if (!value) return '—';
	const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
	return new Intl.DateTimeFormat('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
function displayAmount(base, unit) {
	const divisor = WEIGHT_UNITS[unit] || 1;
	return `${formatNumber(Number(base || 0) / divisor, unit === 'g' || unit === 'bag' ? 0 : 3)} ${UNIT_LABELS[unit] || unit}`;
}
function toBase(quantity, unit) {
	const value = Number(quantity);
	return value * (WEIGHT_UNITS[unit] || 1);
}
function icon(name, size = 18) { return `<i data-lucide="${name}" width="${size}" height="${size}"></i>`; }
function renderIcons() { window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
function toast(message, kind = 'success') {
	const element = document.querySelector('#toast');
	element.textContent = message;
	element.dataset.kind = kind;
	element.classList.add('show');
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}
function config() {
	const saved = window.RAW_MATERIALS_CONFIG || {};
	return { url: saved.supabaseUrl?.trim(), key: saved.supabaseAnonKey?.trim() };
}

function renderSetup() {
	app.innerHTML = `<main class="error-screen"><div>${icon('database-zap', 34)}<h1>النظام غير مهيأ</h1><p>تعذر الاتصال بالنظام حاليًا. تواصل مع مسؤول النظام.</p></div></main>`;
	renderIcons();
}

function renderAuth(message = '') {
	app.innerHTML = `<main class="auth-wrap"><section class="auth-card">
		<a class="brand brand-large" href="#">${icon('boxes', 28)}<span><b>رَوّاد</b><small>إدارة مخازن الخامات</small></span></a>
		<p class="eyebrow">دخول آمن</p><h1>مرحبًا بعودتك</h1><p class="muted">سجّل الدخول للوصول إلى بيانات مخازنك.</p>
		${message ? `<div class="inline-alert">${escapeHtml(message)}</div>` : ''}
		<form id="auth-form" class="form-stack">
			<label>البريد الإلكتروني<input name="email" type="email" placeholder="name@factory.com" required autocomplete="email"></label>
			<label>كلمة المرور<input name="password" type="password" minlength="8" required autocomplete="current-password"></label>
			<button class="button button-primary" type="submit">تسجيل الدخول ${icon('log-in')}</button>
		</form>
		<button class="text-button" data-action="signup">إنشاء حساب المالك لأول مرة</button>
	</section><div class="auth-decoration"><span class="decoration-line"></span>${icon('package-check', 38)}<b>الرصيد الصحيح<br>يبدأ من حركة موثقة</b><span>مصمم لإدارة خامات الإنتاج</span></div></main><div id="modal-root"></div>`;
	document.querySelector('#auth-form').addEventListener('submit', async event => {
		event.preventDefault();
		const values = new FormData(event.currentTarget);
		await withBusy(event.currentTarget.querySelector('button'), async () => {
			const { error } = await state.client.auth.signInWithPassword({ email: values.get('email'), password: values.get('password') });
			if (error) toast(error.message, 'error');
		});
	});
	document.querySelectorAll('.auth-wrap [data-action]').forEach(button => button.addEventListener('click', () => {
		if (button.dataset.action === 'signup') showSignup();
	}));
	renderIcons();
}

async function withBusy(button, callback) {
	if (state.busy) return;
	state.busy = true;
	if (button) { button.disabled = true; button.classList.add('loading'); }
	try { await callback(); }
	catch (error) { toast(error.message || 'حدث خطأ غير متوقع', 'error'); }
	finally { state.busy = false; if (button) { button.disabled = false; button.classList.remove('loading'); } }
}

async function start() {
	const saved = config();
	if (!saved?.url || !saved?.key) return renderSetup();
	if (!window.supabase?.createClient) return renderSetup();
	state.client = window.supabase.createClient(saved.url, saved.key);
	const { data, error } = await state.client.auth.getSession();
	if (error) return renderAuth(error.message);
	state.session = data.session;
	if (state.session) await loadData(); else renderAuth();
	state.client.auth.onAuthStateChange((_event, session) => {
		state.session = session;
		if (session) { loadData(); } else { renderAuth(); }
	});
}

async function loadData() {
	if (!state.session) return;
	const results = await Promise.all([
		selectAllRows('warehouses', 'name'),
		selectAllRows('materials', 'name'),
		selectAllRows('stock_movements', 'happened_at', false)
	]);
	const failed = results.find(result => result.error);
	if (failed) {
		app.innerHTML = `<main class="error-screen"><div>${icon('database-zap', 34)}<h1>تعذر تحميل بيانات النظام</h1><p>${escapeHtml(failed.error.message)}</p><p class="muted">تأكد من تشغيل ملف supabase.sql في SQL Editor بمشروعك الجديد.</p><button class="button button-secondary" data-action="logout">تسجيل الخروج</button></div></main>`;
		renderIcons(); return;
	}
	[state.warehouses, state.materials, state.movements] = results.map(result => result.data || []);
	if (state.warehouseId && !state.warehouses.some(warehouse => warehouse.id === state.warehouseId)) state.warehouseId = null;
	renderApp();
}

async function selectAllRows(table, orderBy, ascending = true) {
	const pageSize = 1000;
	const rows = [];
	for (let start = 0; ; start += pageSize) {
		const { data, error } = await state.client.from(table).select('*')
			.order(orderBy, { ascending }).range(start, start + pageSize - 1);
		if (error) return { data: null, error };
		rows.push(...data);
		if (data.length < pageSize) return { data: rows, error: null };
	}
}

function warehouseKindLabel(kind) { return kind === 'empties' ? 'فوارغ' : 'خامات'; }
function itemBalance(material, until = null) {
	return state.movements.filter(movement => movement.material_id === material.id && (!until || localDateKey(movement.happened_at) <= until))
		.reduce((total, movement) => total + Number(movement.quantity_base), 0);
}
function getWarehouse(id) { return state.warehouses.find(warehouse => warehouse.id === id); }
function getMaterial(id) { return state.materials.find(material => material.id === id); }
function lowStockMaterials() {
	return state.materials.filter(material => Number(material.minimum_base) > 0 && itemBalance(material) <= Number(material.minimum_base));
}
function notificationsEnabled() { return localStorage.getItem(NOTIFICATIONS_KEY) !== 'off'; }
function stockAlertKey(material) { return `${material.id}:${itemBalance(material)}`; }
function unreadLowStockMaterials() {
	if (!notificationsEnabled()) return [];
	let seen = [];
	try { seen = JSON.parse(localStorage.getItem(NOTIFICATIONS_SEEN_KEY) || '[]'); }
	catch { seen = []; }
	return lowStockMaterials().filter(material => !seen.includes(stockAlertKey(material)));
}
function markStockAlertsSeen() {
	const seen = lowStockMaterials().map(stockAlertKey);
	localStorage.setItem(NOTIFICATIONS_SEEN_KEY, JSON.stringify(seen));
}
function pageTitle() {
	if (state.page === 'warehouse' && state.warehouseId) return getWarehouse(state.warehouseId)?.name || 'المخزن';
	return ({ home: 'الرئيسية', warehouses: 'المخازن', empties: 'الفوارغ', reports: 'التقارير', settings: 'الإعدادات' })[state.page] || 'الرئيسية';
}

function renderApp() {
	state.charts.forEach(chart => chart.destroy());
	state.charts = [];
	const dark = localStorage.getItem(THEME_KEY) === 'dark';
	document.documentElement.dataset.theme = dark ? 'dark' : 'light';
	const currentWarehouse = getWarehouse(state.warehouseId);
	app.innerHTML = `<div class="app-shell ${state.page === 'home' ? 'home-page' : 'inner-page'}">
		<aside class="sidebar">
			<a class="brand" href="#" data-page="home">${icon('boxes', 25)}<span><b>رَوّاد</b><small>إدارة المخازن</small></span></a>
			<div class="side-caption">مساحة العمل</div>
			<nav class="side-nav">
				${navLink('home', 'layout-dashboard', 'الرئيسية')}
				${warehouseNavGroup()}
				${navLink('empties', 'package-open', 'الفوارغ')}
				${navLink('reports', 'chart-no-axes-combined', 'التقارير')}
				${navLink('settings', 'settings-2', 'الإعدادات')}
			</nav>
			<div class="sidebar-bottom"><div class="connection"><span class="connection-dot"></span><span>قاعدة البيانات متصلة</span></div>
				<button class="button button-add-warehouse" data-action="add-warehouse">${icon('plus')}<span>إضافة مخزن</span></button>
			</div>
		</aside>
		<main class="main-area">
			<header class="topbar"><div><p class="breadcrumb">إدارة المخزون <span>/</span> ${escapeHtml(pageTitle())}</p><h1>${escapeHtml(pageTitle())}</h1></div>
				${state.page !== 'home' ? `<button class="page-back" data-action="back-home" aria-label="العودة للرئيسية" title="العودة للرئيسية">${icon('arrow-left', 19)}<span>الرئيسية</span></button>` : ''}
				<div class="top-actions">
					<div class="search-wrap"><label class="global-search">${icon('search')}<input id="global-search" type="search" placeholder="ابحث عن مخزن أو صنف" autocomplete="off" aria-label="ابحث عن مخزن أو صنف"><kbd>/</kbd></label><div id="search-results" class="popover search-popover" hidden></div></div>
					<span class="today-chip">${icon('calendar-days')} ${formatDate(new Date())}</span>
					<div class="top-control-wrap"><button class="icon-button notification-trigger" data-action="notifications" title="الإشعارات" aria-label="الإشعارات">${icon('bell')}<span class="notification-count" id="notification-count">${unreadLowStockMaterials().length ? formatNumber(unreadLowStockMaterials().length, 0) : ''}</span></button><div id="notifications-menu" class="popover notifications-popover" hidden></div></div>
					<button class="icon-button theme-toggle" data-action="theme" title="تبديل المظهر" aria-label="تبديل المظهر">${icon(dark ? 'sun' : 'moon')}</button>
					<button class="icon-button settings-trigger" data-action="settings" title="الإعدادات" aria-label="الإعدادات">${icon('settings-2')}</button>
					<div class="top-control-wrap profile-wrap"><button class="profile-trigger" data-action="profile" aria-label="قائمة الحساب"><span class="avatar">${escapeHtml((state.session?.user?.email || 'م').slice(0, 1).toUpperCase())}</span><span class="profile-email">${escapeHtml(state.session?.user?.email || '')}</span>${icon('chevron-down', 15)}</button><div id="profile-menu" class="popover profile-popover" hidden><div class="profile-menu-head"><span class="avatar">${escapeHtml((state.session?.user?.email || 'م').slice(0, 1).toUpperCase())}</span><span><b>الحساب</b><small>${escapeHtml(state.session?.user?.email || '')}</small></span></div><button class="popover-action" data-action="settings">${icon('settings-2')}<span>الإعدادات</span></button><button class="popover-action danger-action" data-action="logout">${icon('log-out')}<span>تسجيل الخروج</span></button></div></div>
				</div>
			</header>
			<section class="page-content">${renderPage(currentWarehouse)}</section>
		</main>
	</div><div id="modal-root"></div>`;
	bindAppEvents();
	renderIcons();
	if (state.page === 'home') {
		renderMovementTrendChart();
		renderStockStatusChart();
	}
}

function navLink(page, iconName, label) {
	const active = state.page === page || (page === 'warehouses' && state.page === 'warehouse');
	return `<button class="nav-link ${active ? 'active' : ''}" data-page="${page}">${icon(iconName)}<span>${label}</span>${active ? '<i class="nav-indicator"></i>' : ''}</button>`;
}

function renderPage(warehouse) {
	if (state.page === 'home') return renderDashboard();
	if (state.page === 'warehouses') return renderWarehouses('raw');
	if (state.page === 'empties') return renderWarehouses('empties');
	if (state.page === 'warehouse' && warehouse) return renderWarehouse(warehouse);
	if (state.page === 'reports') return renderReports();
	if (state.page === 'settings') return renderSettings();
	return renderDashboard();
}

function renderDashboard() {
	const activeWarehouses = state.warehouses.length;
	const additions = state.movements.filter(m => ['opening', 'inbound', 'return', 'adjustment_in', 'transfer_in'].includes(m.movement_type) && m.happened_at >= new Date(Date.now() - 30 * 86400000).toISOString()).length;
	const lowMaterials = lowStockMaterials();
	const chartItems = state.materials.filter(material => Number(material.minimum_base) > 0).map(material => ({ material, balance: itemBalance(material) }))
		.sort((a, b) => (a.balance / Number(a.material.minimum_base)) - (b.balance / Number(b.material.minimum_base))).slice(0, 5);
	const maxRatio = Math.max(1, ...chartItems.map(item => item.balance / Number(item.material.minimum_base) * 100));
	const latest = state.movements.slice(0, 6);
	return `<div class="welcome-row"><div class="welcome-copy"><div class="welcome-heading-row"><h1>الرئيسية</h1><h2>صباح المخزون المنظّم</h2></div><p class="muted">متابعة سريعة للأرصدة والحركات في جميع المخازن.</p></div></div>
		<div class="metric-grid">
			${metricCard('boxes', 'إجمالي الأصناف', state.materials.length, 'صنف مسجل', 'cyan')}
			${metricCard('warehouse', 'المخازن النشطة', activeWarehouses, 'مخزن خامات وفوارغ', 'navy')}
			${metricCard('arrow-down-to-line', 'حركات الإضافة', additions, 'آخر 30 يومًا', 'cyan')}
			${metricCard('triangle-alert', 'تحت الحد الأدنى', lowMaterials.length, 'صنف يحتاج متابعة', 'navy')}
		</div>
		<div class="dashboard-grid charts-row"><section class="panel chart-panel trend-panel"><div class="panel-heading"><div><p class="eyebrow">حركة المخزون</p><h3>الإضافات والصرف خلال ٧ أيام</h3></div><span class="quiet-badge">عدد الحركات</span></div><div class="chart-canvas-wrap"><canvas id="movement-trend-chart" aria-label="رسم بياني لحركات الإضافة والصرف خلال آخر سبعة أيام"></canvas></div></section>
		<section class="panel chart-panel donut-panel"><div class="panel-heading"><div><p class="eyebrow">حالة المخزون</p><h3>توزيع الأصناف</h3></div><span class="quiet-badge">${formatNumber(state.materials.length, 0)} صنف</span></div>
			${state.materials.length ? `<div class="donut-content"><div class="donut-chart-wrap"><canvas id="stock-status-chart" aria-label="رسم دائري لحالة أرصدة الأصناف"></canvas><div class="donut-center"><b>${formatNumber(state.materials.length, 0)}</b><span>إجمالي الأصناف</span></div></div><div class="donut-legend">${stockStatusSegments().filter(segment => segment.count > 0).map(segment => `<div class="donut-legend-row"><i style="--swatch:${segment.color}"></i><span>${segment.label}</span><b>${formatNumber(segment.count, 0)}</b></div>`).join('')}</div></div>` : emptyState('chart-no-axes-combined', 'لا توجد أصناف لعرضها', 'أضف أصنافًا لتظهر حالة المخزون في الرسم.')}
		</section></div>
		<div class="dashboard-grid detail-row"><section class="panel chart-panel stock-panel"><div class="panel-heading"><div><p class="eyebrow">مراقبة المخزون</p><h3>الأصناف الأقرب للحد الأدنى</h3></div><span class="quiet-badge">نسبة الرصيد من الحد</span></div>
			${chartItems.length ? `<div class="chart-list">${chartItems.map(({ material, balance }) => {
				const percent = Math.max(0, balance / Number(material.minimum_base) * 100);
				const warehouseName = getWarehouse(material.warehouse_id)?.name || '';
				return `<div class="chart-item"><div class="chart-label"><span class="chart-name">${escapeHtml(material.name)}<small>${escapeHtml(warehouseName)}</small></span><b>${formatNumber(percent, 0)}%</b><span class="chart-amount">${displayAmount(balance, material.unit)}</span></div><div class="bar-track"><span class="bar-fill ${percent <= 100 ? 'bar-critical' : ''}" style="width:${Math.min(100, percent / maxRatio * 100)}%"></span></div></div>`;
			}).join('')}</div>` : emptyState('chart-no-axes-combined', 'أضف حدًا أدنى للأصناف', 'سيظهر هنا أكثر خمسة أصناف اقترابًا من الحد الأدنى.')}
		</section><section class="panel movement-panel"><div class="panel-heading"><div><p class="eyebrow">آخر التحديثات</p><h3>أحدث الحركات</h3></div><button class="text-link" data-page="reports">عرض التقارير ${icon('arrow-left', 14)}</button></div>
			${latest.length ? `<div class="movement-list">${latest.map(movementRow).join('')}</div>` : emptyState('clock-3', 'لا توجد حركات بعد', 'أضف مخزنًا وصنفًا لبدء تسجيل الرصيد.')}
		</section></div>
		<section class="panel warehouse-strip"><div class="panel-heading"><div><p class="eyebrow">مساحات التخزين</p><h3>مخازنك</h3></div><button class="button button-secondary button-small" data-page="warehouses">كل المخازن ${icon('arrow-left', 15)}</button></div>
			${state.warehouses.length ? `<div class="warehouse-cards">${state.warehouses.slice(0, 4).map(warehouseCard).join('')}</div>` : emptyState('warehouse', 'لم تُضف مخازن بعد', 'ابدأ بإضافة أول مخزن خامات أو فوارغ.')}
		</section>`;
}

function metricCard(iconName, label, value, hint, color) {
	return `<article class="metric-card metric-${color}"><span class="metric-icon">${icon(iconName, 19)}</span><div><span class="metric-label">${label}</span><strong>${formatNumber(value, 0)}</strong><small>${hint}</small></div><span class="metric-accent"></span></article>`;
}

function renderMovementTrendChart() {
	const canvas = document.querySelector('#movement-trend-chart');
	if (!canvas || !window.Chart) return;
	const days = [];
	const todayDate = new Date();
	todayDate.setHours(12, 0, 0, 0);
	for (let offset = 6; offset >= 0; offset--) {
		const date = new Date(todayDate);
		date.setDate(date.getDate() - offset);
		days.push({ key: localDateKey(date), label: new Intl.DateTimeFormat('ar-EG', { weekday: 'short' }).format(date) });
	}
	const incomingTypes = new Set(['opening', 'inbound', 'return', 'adjustment_in', 'transfer_in']);
	const outgoingTypes = new Set(['production_issue', 'adjustment_out', 'transfer_out']);
	const incoming = days.map(day => state.movements.filter(movement => localDateKey(movement.happened_at) === day.key && incomingTypes.has(movement.movement_type)).length);
	const outgoing = days.map(day => state.movements.filter(movement => localDateKey(movement.happened_at) === day.key && outgoingTypes.has(movement.movement_type)).length);
	const styles = getComputedStyle(document.documentElement);
	const muted = styles.getPropertyValue('--muted').trim();
	const grid = styles.getPropertyValue('--line').trim();
	const primary = styles.getPropertyValue('--green').trim();
	const secondary = styles.getPropertyValue('--blue').trim();
	const chart = new window.Chart(canvas, {
		type: 'line',
		data: {
			labels: days.map(day => day.label),
			datasets: [
				{ label: 'إضافة ومرتجعات', data: incoming, borderColor: primary, backgroundColor: 'rgba(20, 166, 186, .12)', fill: true, tension: .36, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
				{ label: 'صرف وتسويات', data: outgoing, borderColor: secondary, backgroundColor: 'rgba(70, 119, 206, .08)', fill: false, tension: .36, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 }
			]
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: 'index', intersect: false },
			plugins: {
				legend: { position: 'bottom', rtl: true, labels: { color: muted, usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 18, font: { family: 'IBM Plex Sans Arabic', size: 10 } } },
				tooltip: { rtl: true, titleFont: { family: 'IBM Plex Sans Arabic' }, bodyFont: { family: 'IBM Plex Sans Arabic' } }
			},
			scales: {
				x: { grid: { display: false }, border: { display: false }, ticks: { color: muted, font: { family: 'IBM Plex Sans Arabic', size: 9 } } },
				y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { precision: 0, color: muted, stepSize: 1, font: { family: 'IBM Plex Sans Arabic', size: 9 } } }
			}
		}
	});
	state.charts.push(chart);
}

function stockStatusSegments() {
	const configured = state.materials.filter(material => Number(material.minimum_base) > 0).length;
	const low = lowStockMaterials().length;
	return [
		{ label: 'تحت الحد الأدنى', count: low, color: getComputedStyle(document.documentElement).getPropertyValue('--red').trim() },
		{ label: 'ضمن الحد', count: configured - low, color: getComputedStyle(document.documentElement).getPropertyValue('--green').trim() },
		{ label: 'الحد غير محدد', count: state.materials.length - configured, color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() }
	];
}

function renderStockStatusChart() {
	const canvas = document.querySelector('#stock-status-chart');
	if (!canvas || !window.Chart) return;
	const segments = stockStatusSegments().filter(segment => segment.count > 0);
	const styles = getComputedStyle(document.documentElement);
	const chart = new window.Chart(canvas, {
		type: 'doughnut',
		data: {
			labels: segments.map(segment => segment.label),
			datasets: [{ data: segments.map(segment => segment.count), backgroundColor: segments.map(segment => segment.color), borderColor: styles.getPropertyValue('--surface').trim(), borderWidth: 4, hoverOffset: 6 }]
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			cutout: '72%',
			plugins: {
				legend: { display: false },
				tooltip: { rtl: true, titleFont: { family: 'IBM Plex Sans Arabic' }, bodyFont: { family: 'IBM Plex Sans Arabic' }, callbacks: { label: context => `${context.label}: ${formatNumber(context.raw, 0)} صنف` } }
			}
		}
	});
	state.charts.push(chart);
}
function emptyState(iconName, title, subtitle) {
	return `<div class="empty-state">${icon(iconName, 27)}<b>${title}</b><span>${subtitle}</span></div>`;
}
function warehouseCard(warehouse) {
	const count = state.materials.filter(material => material.warehouse_id === warehouse.id).length;
	return `<button class="warehouse-card" data-open-warehouse="${warehouse.id}"><span class="warehouse-icon ${warehouse.kind === 'empties' ? 'empty-icon' : ''}">${icon(warehouse.kind === 'empties' ? 'package-open' : 'warehouse')}</span><span class="warehouse-card-copy"><b>${escapeHtml(warehouse.name)}</b><small>${warehouseKindLabel(warehouse.kind)} · ${formatNumber(count, 0)} أصناف</small></span>${icon('arrow-up-left', 17)}</button>`;
}

function warehouseNavGroup() {
	const active = state.page === 'warehouses' || state.page === 'warehouse';
	const subItems = state.warehouses.length
		? state.warehouses.map(warehouse => `<button class="side-sub-link ${state.page === 'warehouse' && state.warehouseId === warehouse.id ? 'active' : ''}" data-open-warehouse="${warehouse.id}"><span class="sub-link-dot ${warehouse.kind === 'empties' ? 'empty-dot' : ''}"></span><span>${escapeHtml(warehouse.name)}</span><small>${warehouseKindLabel(warehouse.kind)}</small></button>`).join('')
		: '<span class="side-sub-empty">لا توجد مخازن بعد</span>';
	return `<div class="side-nav-group"><button class="nav-link ${active ? 'active' : ''}" data-toggle-warehouses aria-expanded="${state.warehousesExpanded}">${icon('warehouse')}<span>المخازن</span>${icon(state.warehousesExpanded ? 'chevron-down' : 'chevron-left', 15)}${active ? '<i class="nav-indicator"></i>' : ''}</button><div class="sidebar-subnav" ${state.warehousesExpanded ? '' : 'hidden'}><button class="side-sub-link all-warehouses-link" data-page="warehouses">${icon('list', 14)}<span>عرض كل المخازن</span></button>${subItems}</div></div>`;
}

function renderWarehouses(kind) {
	const warehouses = state.warehouses.filter(warehouse => warehouse.kind === kind);
	const isEmpties = kind === 'empties';
	return `<div class="section-intro"><div><p class="eyebrow">${isEmpties ? 'مواد التعبئة' : 'المواد الخام'}</p><h2>${isEmpties ? 'مخازن الفوارغ' : 'مخازن الخامات'}</h2><p class="muted">${isEmpties ? 'أرصدة الشكاير ومستلزمات التعبئة.' : 'الأصناف والكميات والموردون لكل مخزن.'}</p></div><button class="button button-primary" data-action="add-warehouse" data-kind="${kind}">${icon('plus')} إضافة ${isEmpties ? 'مخزن فوارغ' : 'مخزن خامات'}</button></div>
	${warehouses.length ? `<div class="warehouse-grid">${warehouses.map(warehouseCard).join('')}</div>` : `<section class="panel empty-panel">${emptyState(isEmpties ? 'package-open' : 'warehouse', `لا توجد مخازن ${isEmpties ? 'فوارغ' : 'خامات'}`, 'أنشئ مخزنًا، ثم أضف الأصناف ورصيدها الافتتاحي.')}</section>`}`;
}

function renderWarehouse(warehouse) {
	const materials = state.materials.filter(material => material.warehouse_id === warehouse.id);
	const isEmpties = warehouse.kind === 'empties';
	return `<div class="section-intro"><div><h2>${escapeHtml(warehouse.name)}</h2><span class="kind-badge ${isEmpties ? 'kind-empty' : ''}">${warehouseKindLabel(warehouse.kind)}</span></div><div class="inline-actions"><button class="button button-danger-outline" data-action="delete-warehouse" data-warehouse="${warehouse.id}">${icon('trash-2')} حذف المخزن</button><button class="button button-secondary" data-action="movement" data-warehouse="${warehouse.id}">${icon('repeat-2')} حركة مخزون</button><button class="button button-primary" data-action="add-material" data-warehouse="${warehouse.id}">${icon('plus')} إضافة صنف</button></div></div>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">الرصيد الحالي</p><h3>الأصناف في المخزن</h3></div><span class="quiet-badge">${formatNumber(materials.length, 0)} أصناف</span></div>
		${materials.length ? `<div class="table-scroll"><table><thead><tr><th>اسم الصنف</th><th>الرصيد الحالي</th><th>الحد الأدنى</th><th>آخر حركة</th><th>الحالة</th><th></th></tr></thead><tbody>${materials.map(material => materialTableRow(material)).join('')}</tbody></table></div>` : emptyState(isEmpties ? 'package-open' : 'flask-conical', 'المخزن فارغ حتى الآن', 'أضف صنفًا وسجل رصيده الافتتاحي للبدء.')}</section>`;
}

function materialTableRow(material, balance = itemBalance(material), atDate = null) {
	const minimum = Number(material.minimum_base || 0);
	const low = minimum > 0 && balance <= minimum;
	const last = state.movements.find(movement => movement.material_id === material.id && (!atDate || localDateKey(movement.happened_at) <= atDate));
	return `<tr><td><b class="table-primary">${escapeHtml(material.name)}</b><small>${warehouseKindLabel(getWarehouse(material.warehouse_id)?.kind || 'raw')}</small></td><td class="amount-cell">${displayAmount(balance, material.unit)}</td><td>${minimum ? displayAmount(minimum, material.unit) : 'غير محدد'}</td><td>${last ? formatDate(last.happened_at) : '—'}</td><td><span class="status ${low ? 'status-low' : 'status-ok'}">${low ? 'منخفض' : 'طبيعي'}</span></td><td><button class="icon-button row-action" data-action="movement" data-warehouse="${material.warehouse_id}" data-material="${material.id}" title="تسجيل حركة">${icon('plus')}</button><button class="icon-button row-action" data-action="edit-material" data-material="${material.id}" title="تعديل الصنف">${icon('pencil')}</button><button class="row-delete-button" data-action="delete-material" data-material="${material.id}" title="حذف الصنف">${icon('trash-2')}<span>حذف</span></button></td></tr>`;
}

function renderReports() {
	const rows = state.materials.map(material => ({ material, balance: itemBalance(material, state.reportDate) }));
	const low = rows.filter(({ material, balance }) => Number(material.minimum_base) > 0 && balance <= Number(material.minimum_base));
	const movementRows = state.movements.filter(movement => localDateKey(movement.happened_at) <= state.reportDate);
	return `<div class="section-intro"><div><p class="eyebrow">مراجعة الأرصدة</p><h2>التقارير</h2><p class="muted">استعرض أرصدة الأصناف كما كانت في تاريخ محدد.</p></div><div class="report-controls"><label>الرصيد حتى تاريخ<input id="report-date" type="date" value="${state.reportDate}" max="${today()}"></label><button class="button button-secondary" data-action="export-report">${icon('file-down')} تصدير CSV</button></div></div>
		<div class="report-summary"><div class="report-stat">${icon('boxes')}<span>الأصناف</span><b>${formatNumber(rows.length, 0)}</b></div><div class="report-stat warning-stat">${icon('triangle-alert')}<span>تحت الحد الأدنى</span><b>${formatNumber(low.length, 0)}</b></div><div class="report-stat">${icon('activity')}<span>إجمالي الحركات حتى التاريخ</span><b>${formatNumber(movementRows.length, 0)}</b></div></div>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">جرد تاريخي</p><h3>الأرصدة في ${formatDate(state.reportDate)}</h3></div><span class="quiet-badge">${formatNumber(rows.length, 0)} صنف</span></div>
		${rows.length ? `<div class="table-scroll"><table><thead><tr><th>الصنف</th><th>المخزن</th><th>الرصيد بالتاريخ المحدد</th><th>الحد الأدنى</th><th>الحالة</th><th>آخر حركة حتى التاريخ</th></tr></thead><tbody>${rows.map(({ material, balance }) => {
			const minimum = Number(material.minimum_base || 0);
			const isLow = minimum > 0 && balance <= minimum;
			const last = state.movements.find(m => m.material_id === material.id && localDateKey(m.happened_at) <= state.reportDate);
			return `<tr><td><b class="table-primary">${escapeHtml(material.name)}</b></td><td>${escapeHtml(getWarehouse(material.warehouse_id)?.name || '')}</td><td class="amount-cell">${displayAmount(balance, material.unit)}</td><td>${minimum ? displayAmount(minimum, material.unit) : '—'}</td><td><span class="status ${isLow ? 'status-low' : 'status-ok'}">${isLow ? 'منخفض' : 'طبيعي'}</span></td><td>${last ? formatDate(last.happened_at) : '—'}</td></tr>`;
		}).join('')}</tbody></table></div>` : emptyState('file-chart-column', 'لا توجد بيانات للتقرير', 'أضف مخزنًا وأصنافًا لتظهر الأرصدة هنا.')}</section>
		${low.length ? `<section class="panel low-panel"><div class="panel-heading"><div><p class="eyebrow">تنبيه مخزون</p><h3>أصناف تحت الحد الأدنى</h3></div><span class="status status-low">${formatNumber(low.length, 0)} أصناف</span></div><div class="table-scroll"><table><thead><tr><th>الصنف</th><th>المخزن</th><th>الرصيد</th><th>الحد الأدنى</th></tr></thead><tbody>${low.map(({ material, balance }) => `<tr><td>${escapeHtml(material.name)}</td><td>${escapeHtml(getWarehouse(material.warehouse_id)?.name || '')}</td><td>${displayAmount(balance, material.unit)}</td><td>${displayAmount(material.minimum_base, material.unit)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
}

function renderSettings() {
	const dark = localStorage.getItem(THEME_KEY) === 'dark';
	const lowAlerts = notificationsEnabled();
	return `<div class="section-intro"><div><p class="eyebrow">تخصيص مساحة العمل</p><h2>الإعدادات</h2><p class="muted">تحكم في طريقة عرض النظام والتنبيهات.</p></div></div>
		<div class="settings-page-grid"><section class="panel settings-page-panel"><div class="panel-heading"><div><p class="eyebrow">المظهر</p><h3>ألوان مساحة العمل</h3></div>${icon('sun-moon', 20)}</div><p class="settings-description">اختر المظهر المناسب لاستخدامك. سيتم حفظ اختيارك على هذا الجهاز.</p><div class="segmented-control page-theme-control"><button class="segment-option ${dark ? '' : 'selected'}" data-theme-choice="light">${icon('sun', 15)} فاتح</button><button class="segment-option ${dark ? 'selected' : ''}" data-theme-choice="dark">${icon('moon', 15)} داكن</button></div></section>
		<section class="panel settings-page-panel"><div class="panel-heading"><div><p class="eyebrow">الإشعارات</p><h3>تنبيهات المخزون</h3></div>${icon('bell-ring', 20)}</div><div class="settings-row settings-page-row"><div class="settings-label"><span class="settings-symbol">${icon('triangle-alert')}</span><span><b>انخفاض الكمية</b><small>اعرض إشعارًا عندما يصل رصيد صنف إلى حده الأدنى أو أقل.</small></span></div><label class="switch-control"><input id="low-stock-alert-setting" type="checkbox" ${lowAlerts ? 'checked' : ''}><span class="switch-track"></span></label></div></section>
		<section class="panel settings-page-panel account-settings-panel"><div class="panel-heading"><div><p class="eyebrow">الحساب</p><h3>الملف الشخصي</h3></div>${icon('user-round', 20)}</div><div class="settings-account"><span class="avatar">${escapeHtml((state.session?.user?.email || 'م').slice(0, 1).toUpperCase())}</span><span><small>البريد المسجل</small><b>${escapeHtml(state.session?.user?.email || '')}</b></span></div><p class="settings-description">إدارة بيانات الدخول تتم من حساب المصادقة المرتبط بمشروع Supabase.</p></section></div>`;
}

function movementRow(movement) {
	const material = getMaterial(movement.material_id);
	if (!material) return '';
	const incoming = Number(movement.quantity_base) >= 0;
	const amount = `${incoming ? '+' : '−'} ${displayAmount(Math.abs(Number(movement.quantity_base)), material.unit)}`;
	return `<div class="movement-row"><span class="movement-symbol ${incoming ? 'incoming' : 'outgoing'}">${icon(incoming ? 'arrow-down-left' : 'arrow-up-left', 16)}</span><span class="movement-copy"><b>${escapeHtml(material.name)}</b><small>${MOVEMENT_LABELS[movement.movement_type] || 'حركة'} · ${formatDate(movement.happened_at)}</small></span><b class="movement-amount ${incoming ? 'positive' : 'negative'}">${amount}</b><button class="icon-button row-action" data-edit-movement="${movement.id}" title="تعديل تاريخ الحركة">${icon('calendar-cog')}</button></div>`;
}

function bindAppEvents() {
	app.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
		state.page = button.dataset.page; state.warehouseId = null; renderApp();
	}));
	app.querySelectorAll('[data-toggle-warehouses]').forEach(button => button.addEventListener('click', () => {
		state.warehousesExpanded = !state.warehousesExpanded;
		renderApp();
	}));
	app.querySelectorAll('[data-open-warehouse]').forEach(button => button.addEventListener('click', () => {
		state.page = 'warehouse'; state.warehouseId = button.dataset.openWarehouse; state.warehousesExpanded = true; renderApp();
	}));
	app.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleAction(button)));
	app.querySelectorAll('[data-edit-movement]').forEach(button => button.addEventListener('click', () => showEditMovementDateModal(button.dataset.editMovement)));
	app.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => {
		localStorage.setItem(THEME_KEY, button.dataset.themeChoice);
		renderApp();
	}));
	app.querySelector('#low-stock-alert-setting')?.addEventListener('change', event => {
		localStorage.setItem(NOTIFICATIONS_KEY, event.target.checked ? 'on' : 'off');
		renderApp();
	});
	const searchInput = app.querySelector('#global-search');
	searchInput?.addEventListener('input', () => renderSearchResults(searchInput.value));
	searchInput?.addEventListener('focus', () => { if (searchInput.value.trim()) renderSearchResults(searchInput.value); });
	app.querySelector('#report-date')?.addEventListener('change', event => { state.reportDate = event.target.value || today(); renderApp(); });
}

function handleAction(button) {
	const action = button.dataset.action;
	if (action === 'back-home') { state.page = 'home'; state.warehouseId = null; renderApp(); }
	if (action === 'theme') { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); renderApp(); }
	if (action === 'profile') { document.querySelector('#profile-menu').hidden = !document.querySelector('#profile-menu').hidden; document.querySelector('#notifications-menu').hidden = true; }
	if (action === 'notifications') {
		const menu = document.querySelector('#notifications-menu');
		menu.hidden = !menu.hidden;
		document.querySelector('#profile-menu').hidden = true;
		if (!menu.hidden) {
			markStockAlertsSeen();
			document.querySelector('#notification-count').textContent = '';
			renderNotifications(menu);
		}
	}
	if (action === 'settings') { state.page = 'settings'; state.warehouseId = null; renderApp(); }
	if (action === 'add-warehouse') showWarehouseModal(button.dataset.kind || 'raw');
	if (action === 'add-material') showMaterialModal(button.dataset.warehouse);
	if (action === 'movement') showMovementModal(button.dataset.warehouse, button.dataset.material);
	if (action === 'edit-material') showEditMaterialModal(button.dataset.material);
	if (action === 'delete-material') showDeleteModal('material', button.dataset.material);
	if (action === 'delete-warehouse') showDeleteModal('warehouse', button.dataset.warehouse);
	if (action === 'logout') state.client.auth.signOut();
	if (action === 'signup') showSignup();
	if (action === 'export-report') exportReport();
}

function renderSearchResults(query) {
	const resultsElement = document.querySelector('#search-results');
	if (!resultsElement) return;
	const term = query.trim().toLocaleLowerCase();
	if (!term) { resultsElement.hidden = true; resultsElement.innerHTML = ''; return; }
	const warehouses = state.warehouses.filter(warehouse => warehouse.name.toLocaleLowerCase().includes(term)).slice(0, 5);
	const materials = state.materials.filter(material => material.name.toLocaleLowerCase().includes(term)).slice(0, 7);
	const hasResults = warehouses.length || materials.length;
	resultsElement.innerHTML = `<div class="popover-heading">${icon('search', 15)} نتائج البحث</div>${hasResults ? `${warehouses.map(warehouse => `<button class="search-result" data-search-warehouse="${warehouse.id}"><span class="result-icon">${icon(warehouse.kind === 'empties' ? 'package-open' : 'warehouse', 16)}</span><span><b>${escapeHtml(warehouse.name)}</b><small>مخزن ${warehouseKindLabel(warehouse.kind)}</small></span>${icon('arrow-up-left', 15)}</button>`).join('')}${materials.map(material => `<button class="search-result" data-search-warehouse="${material.warehouse_id}"><span class="result-icon result-material">${icon('package', 16)}</span><span><b>${escapeHtml(material.name)}</b><small>${escapeHtml(getWarehouse(material.warehouse_id)?.name || 'مخزن')}</small></span><span class="result-amount">${displayAmount(itemBalance(material), material.unit)}</span></button>`).join('')}` : `<div class="popover-empty">لا توجد مخازن أو أصناف مطابقة.</div>`}`;
	resultsElement.hidden = false;
	resultsElement.querySelectorAll('[data-search-warehouse]').forEach(result => result.addEventListener('click', () => {
		state.page = 'warehouse'; state.warehouseId = result.dataset.searchWarehouse; renderApp();
	}));
}

function renderNotifications(menu) {
	const lowMaterials = notificationsEnabled() ? lowStockMaterials() : [];
	const recent = state.movements.slice(0, 4);
	menu.innerHTML = `<div class="popover-heading">${icon('bell', 15)} الإشعارات<span class="notification-summary">${formatNumber(lowMaterials.length, 0)} تنبيه مخزون</span></div>${lowMaterials.length ? `<div class="notification-section-label">تحتاج إعادة طلب</div>${lowMaterials.slice(0, 5).map(material => `<button class="notification-item" data-notification-warehouse="${material.warehouse_id}"><span class="notification-warning">${icon('triangle-alert', 16)}</span><span><b>${escapeHtml(material.name)}</b><small>المتاح ${displayAmount(itemBalance(material), material.unit)} · الحد ${displayAmount(material.minimum_base, material.unit)}</small></span>${icon('arrow-up-left', 14)}</button>`).join('')}` : `<div class="notifications-clear">${icon('circle-check', 18)}<span>${notificationsEnabled() ? 'لا توجد أصناف تحت الحد الأدنى.' : 'تنبيهات انخفاض المخزون متوقفة من الإعدادات.'}</span></div>`}${recent.length ? `<div class="notification-section-label recent-label">آخر الحركات</div>${recent.map(movement => {
		const material = getMaterial(movement.material_id);
		return material ? `<div class="notification-activity"><span class="activity-dot"></span><span><b>${escapeHtml(material.name)}</b><small>${MOVEMENT_LABELS[movement.movement_type] || 'حركة'} · ${formatDate(movement.happened_at)}</small></span></div>` : '';
	}).join('')}` : ''}<button class="popover-footer" data-notification-reports>عرض التقارير ${icon('arrow-left', 14)}</button>`;
	menu.querySelectorAll('[data-notification-warehouse]').forEach(item => item.addEventListener('click', () => {
		state.page = 'warehouse'; state.warehouseId = item.dataset.notificationWarehouse; renderApp();
	}));
	menu.querySelector('[data-notification-reports]')?.addEventListener('click', () => { state.page = 'reports'; state.warehouseId = null; renderApp(); });
}

function showModal(title, description, content) {
	document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-dismiss><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">${title}</h2><p>${description}</p></div><button class="icon-button" data-dismiss aria-label="إغلاق">${icon('x')}</button></header>${content}</section></div>`;
	document.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) closeModal(); });
	bindModal(); renderIcons();
}
function closeModal() { document.querySelector('#modal-root').innerHTML = ''; }
function bindModal() {
	document.querySelectorAll('#modal-root .modal [data-dismiss]').forEach(button => button.addEventListener('click', closeModal));
	document.querySelector('#warehouse-kind')?.addEventListener('change', event => {
		const unit = document.querySelector('#warehouse-unit');
		if (unit) unit.innerHTML = unitOptions(event.target.value === 'empties');
	});
	document.querySelector('#movement-type')?.addEventListener('change', updateMovementForm);
	document.querySelector('#movement-material')?.addEventListener('change', updateMovementUnit);
	document.querySelector('#modal-form')?.addEventListener('submit', event => submitModal(event));
}

function unitOptions(empties, selected = '') {
	const units = empties ? [['bag', 'شكارة']] : [['kg', 'كيلو'], ['g', 'جرام'], ['ton', 'طن']];
	return units.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}
function showWarehouseModal(kind = 'raw') {
	showModal('إضافة مخزن', 'حدد اسم المخزن ونوع المحتويات.', `<form id="modal-form" class="form-stack" data-form="warehouse">
		<label>اسم المخزن<input name="name" maxlength="80" placeholder="مثال: مخزن المواد السائلة" required></label>
		<label>نوع المخزن<select id="warehouse-kind" name="kind"><option value="raw" ${kind === 'raw' ? 'selected' : ''}>خامات</option><option value="empties" ${kind === 'empties' ? 'selected' : ''}>فوارغ</option></select></label>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">إنشاء المخزن ${icon('plus')}</button></div>
	</form>`);
}
function showMaterialModal(warehouseId) {
	const warehouse = getWarehouse(warehouseId);
	if (!warehouse) return;
	const empties = warehouse.kind === 'empties';
	showModal('إضافة صنف', `مخزن ${escapeHtml(warehouse.name)} · الرصيد الافتتاحي يُسجل بتاريخ اختياري.`, `<form id="modal-form" class="form-stack" data-form="material" data-warehouse="${warehouse.id}">
		<label>اسم الصنف<input name="name" maxlength="100" placeholder="اكتب اسم الصنف" required></label>
		<div class="form-grid"><label>وحدة القياس<select name="unit">${unitOptions(empties)}</select></label><label>الحد الأدنى ${empties ? '(شكارة)' : ''}<input name="minimum" type="number" min="0" step="any" value="0"></label></div>
		<div class="form-grid"><label>الرصيد الافتتاحي<input name="opening" type="number" min="0" step="any" value="0"></label><label>تاريخ الرصيد<input name="date" type="date" value="${today()}" max="${today()}" required></label></div>
		<label>المورد ${empties ? '(اختياري)' : ''}<input name="supplier" maxlength="120" placeholder="اسم المورد"></label>
		<p class="form-hint">كل صنف يُحفظ باسمه كما تدخله، ويُسجل رصيده الافتتاحي كحركة مستقلة بتاريخها.</p>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">حفظ الصنف ${icon('check')}</button></div>
	</form>`);
}

function showEditMaterialModal(materialId) {
	const material = getMaterial(materialId);
	if (!material) return;
	const divisor = WEIGHT_UNITS[material.unit] || 1;
	showModal('تعديل بيانات الصنف', 'يؤثر تعديل الاسم على الحركات السابقة المرتبطة به، ولا يغيّر سجل الأرصدة.', `<form id="modal-form" class="form-stack" data-form="edit-material" data-material="${material.id}">
		<label>اسم الصنف<input name="name" maxlength="100" value="${escapeHtml(material.name)}" required></label>
		<label>الحد الأدنى (${UNIT_LABELS[material.unit]})<input name="minimum" type="number" min="0" step="any" value="${Number(material.minimum_base) / divisor}" required></label>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">حفظ التعديل ${icon('check')}</button></div>
	</form>`);
}

function showEditMovementDateModal(movementId) {
	const movement = state.movements.find(item => item.id === movementId);
	if (!movement) return;
	const material = getMaterial(movement.material_id);
	showModal('تعديل تاريخ الحركة', `${material ? escapeHtml(material.name) : 'الصنف'} · سيتم تحديث تاريخ السجل فقط.`, `<form id="modal-form" class="form-stack" data-form="edit-movement-date" data-movement="${movement.id}">
		<label>تاريخ الحركة<input name="date" type="date" value="${localDateKey(movement.happened_at)}" max="${today()}" required></label>
		<p class="form-hint">سيظهر التاريخ المحدّث في سجل الحركات والتقارير بعد الحفظ.</p>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">حفظ التاريخ ${icon('check')}</button></div>
	</form>`);
}

function showDeleteModal(kind, id) {
	const isWarehouse = kind === 'warehouse';
	const record = isWarehouse ? getWarehouse(id) : getMaterial(id);
	if (!record) return;
	const title = isWarehouse ? 'حذف المخزن' : 'حذف الصنف';
	const warning = isWarehouse
		? 'سيؤدي ذلك إلى حذف المخزن وأصنافه وجميع حركاتها نهائيًا، ولن تظهر هذه البيانات في التقارير.'
		: 'سيؤدي ذلك إلى حذف الصنف وجميع حركاته نهائيًا، ولن يظهر رصيده السابق في التقارير.';
	showModal(title, `تأكيد حذف «${escapeHtml(record.name)}».`, `<form id="modal-form" class="form-stack" data-form="delete-record" data-kind="${kind}" data-record="${id}">
		<div class="delete-warning">${icon('triangle-alert')}<span>${warning}</span></div>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-danger" type="submit">حذف نهائي ${icon('trash-2')}</button></div>
	</form>`);
}

function showMovementModal(warehouseId, materialId = '') {
	const warehouse = getWarehouse(warehouseId);
	const materials = state.materials.filter(material => material.warehouse_id === warehouseId);
	if (!warehouse || !materials.length) { toast('أضف صنفًا للمخزن أولًا', 'error'); return; }
	const materialOptions = materials.map(material => `<option value="${material.id}" ${material.id === materialId ? 'selected' : ''}>${escapeHtml(material.name)}</option>`).join('');
	const destinations = state.warehouses.filter(item => item.kind === warehouse.kind && item.id !== warehouse.id);
	showModal('تسجيل حركة مخزون', `مخزن ${escapeHtml(warehouse.name)} · سيتم حفظ الحركة بتاريخها.`, `<form id="modal-form" class="form-stack" data-form="movement" data-warehouse="${warehouse.id}">
		<div class="form-grid"><label>نوع الحركة<select id="movement-type" name="type"><option value="inbound">إضافة كمية</option><option value="production_issue">صرف للإنتاج</option><option value="return">مرتجع من الإنتاج</option><option value="adjustment">تسوية جرد</option><option value="transfer">تحويل لمخزن آخر</option></select></label><label>الصنف<select id="movement-material" name="material" required>${materialOptions}</select></label></div>
		<div class="form-grid"><label id="quantity-label">الكمية<input name="quantity" type="number" min="0.000001" step="any" required></label><label>وحدة الحركة<select id="movement-unit" name="unit">${unitOptions(warehouse.kind === 'empties', getMaterial(materialId)?.unit)}</select></label></div>
		<label>تاريخ الحركة<input name="date" type="date" value="${today()}" max="${today()}" required></label>
		<label id="supplier-field">المورد<input name="supplier" maxlength="120" placeholder="اسم المورد"></label>
		<label id="destination-field" class="hidden">المخزن المحول إليه<select name="destination">${destinations.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label>
		<label id="reason-field" class="hidden">سبب التسوية<input name="reason" maxlength="200" placeholder="مثال: فرق جرد فعلي" ></label>
		<label>ملاحظات<input name="notes" maxlength="250" placeholder="اختياري"></label>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">حفظ الحركة ${icon('check')}</button></div>
	</form>`);
	updateMovementForm();
}

function updateMovementForm() {
	const type = document.querySelector('#movement-type')?.value;
	document.querySelector('#destination-field')?.classList.toggle('hidden', type !== 'transfer');
	document.querySelector('#reason-field')?.classList.toggle('hidden', type !== 'adjustment');
	document.querySelector('#supplier-field')?.classList.toggle('hidden', type !== 'inbound');
	const label = document.querySelector('#quantity-label');
	if (label) label.firstChild.textContent = type === 'adjustment' ? 'الرصيد الفعلي بعد الجرد' : type === 'transfer' ? 'كمية التحويل' : 'الكمية';
}

function updateMovementUnit() {
	const material = getMaterial(document.querySelector('#movement-material')?.value);
	const warehouse = material && getWarehouse(material.warehouse_id);
	const unit = document.querySelector('#movement-unit');
	if (material && warehouse && unit) unit.innerHTML = unitOptions(warehouse.kind === 'empties', material.unit);
}

function showSignup() {
	showModal('إنشاء حساب المالك', 'هذا الحساب له مساحة بيانات مستقلة في قاعدة Supabase.', `<form id="modal-form" class="form-stack" data-form="signup">
		<label>البريد الإلكتروني<input name="email" type="email" required autocomplete="email"></label><label>كلمة المرور<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
		<p class="form-hint">للدخول فورًا، أوقف Confirm email من Authentication ثم Sign In / Providers في Supabase.</p>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">إنشاء الحساب ${icon('user-round-plus')}</button></div>
	</form>`);
}

async function submitModal(event) {
	event.preventDefault();
	const form = event.currentTarget;
	const values = new FormData(form);
	const button = form.querySelector('[type="submit"]');
	await withBusy(button, async () => {
		const type = form.dataset.form;
		if (type === 'warehouse') await createWarehouse(values);
		if (type === 'material') await createMaterial(values, form.dataset.warehouse);
		if (type === 'edit-material') await updateMaterial(values, form.dataset.material);
		if (type === 'edit-movement-date') await updateMovementDate(values, form.dataset.movement);
		if (type === 'delete-record') await deleteRecord(form.dataset.kind, form.dataset.record);
		if (type === 'movement') await createMovement(values, form.dataset.warehouse);
		if (type === 'signup') await createAccount(values);
	});
}

async function createWarehouse(values) {
	const name = values.get('name').trim();
	if (state.warehouses.some(item => item.name.toLowerCase() === name.toLowerCase())) throw new Error('يوجد مخزن بهذا الاسم بالفعل');
	const { error } = await state.client.from('warehouses').insert({ name, kind: values.get('kind'), user_id: state.session.user.id });
	if (error) throw error;
	closeModal(); await loadData(); toast('تم إنشاء المخزن');
}
async function createMaterial(values, warehouseId) {
	const name = values.get('name').trim();
	if (state.materials.some(item => item.warehouse_id === warehouseId && item.name.toLowerCase() === name.toLowerCase())) throw new Error('هذا الصنف موجود بالفعل في المخزن');
	const unit = values.get('unit');
	const minimum = toBase(values.get('minimum') || 0, unit);
	const { data: material, error } = await state.client.from('materials').insert({
		warehouse_id: warehouseId, name, unit, minimum_base: minimum, user_id: state.session.user.id
	}).select().single();
	if (error) throw error;
	const opening = Number(values.get('opening') || 0);
	if (opening > 0) {
		const { error: movementError } = await state.client.from('stock_movements').insert({
			warehouse_id: warehouseId, material_id: material.id, movement_type: 'opening',
			quantity_base: toBase(opening, unit), supplier: values.get('supplier')?.trim() || null,
			happened_at: dateInputTimestamp(values.get('date')), notes: 'رصيد افتتاحي', user_id: state.session.user.id
		});
		if (movementError) throw movementError;
	}
	closeModal(); await loadData(); toast(opening > 0 ? 'تم حفظ الصنف ورصيده الافتتاحي' : 'تم حفظ الصنف');
}

async function updateMaterial(values, materialId) {
	const material = getMaterial(materialId);
	if (!material) throw new Error('تعذر العثور على الصنف');
	const name = values.get('name').trim();
	if (state.materials.some(item => item.id !== materialId && item.warehouse_id === material.warehouse_id && item.name.toLowerCase() === name.toLowerCase())) throw new Error('يوجد صنف بهذا الاسم في المخزن');
	const { error } = await state.client.from('materials').update({ name, minimum_base: toBase(values.get('minimum'), material.unit) }).eq('id', materialId);
	if (error) throw error;
	closeModal(); await loadData(); toast('تم تحديث بيانات الصنف');
}

async function updateMovementDate(values, movementId) {
	const movement = state.movements.find(item => item.id === movementId);
	if (!movement) throw new Error('تعذر العثور على الحركة');
	const happenedAt = dateInputTimestamp(values.get('date'));
	let query = state.client.from('stock_movements').update({ happened_at: happenedAt });
	if (movement.transfer_ref) query = query.eq('transfer_ref', movement.transfer_ref);
	else query = query.eq('id', movement.id);
	const { error } = await query;
	if (error) throw error;
	closeModal(); await loadData(); toast('تم تحديث تاريخ الحركة');
}

async function deleteRecord(kind, id) {
	const table = kind === 'warehouse' ? 'warehouses' : 'materials';
	const { error } = await state.client.from(table).delete().eq('id', id);
	if (error) throw error;
	if (kind === 'warehouse' && state.warehouseId === id) state.warehouseId = null;
	closeModal(); await loadData(); toast(kind === 'warehouse' ? 'تم حذف المخزن وسجلاته التابعة' : 'تم حذف الصنف وحركاته');
}

async function createMovement(values, warehouseId) {
	const material = getMaterial(values.get('material'));
	const warehouse = getWarehouse(warehouseId);
	if (!material || !warehouse) throw new Error('تعذر العثور على الصنف أو المخزن');
	const date = dateInputTimestamp(values.get('date'));
	const baseValues = { warehouse_id: warehouseId, material_id: material.id, happened_at: date, notes: values.get('notes')?.trim() || null, user_id: state.session.user.id };
	const type = values.get('type');
	let record;
	if (type === 'adjustment') {
		const actual = toBase(values.get('quantity'), values.get('unit'));
		const difference = actual - itemBalance(material, values.get('date'));
		if (Math.abs(difference) < 0.000001) throw new Error('الرصيد الفعلي مطابق لرصيد النظام، لا توجد تسوية');
		if (difference < 0 && actual < 0) throw new Error('الرصيد الفعلي لا يمكن أن يكون سالبًا');
		record = { ...baseValues, quantity_base: difference, movement_type: difference > 0 ? 'adjustment_in' : 'adjustment_out', notes: [values.get('reason').trim(), baseValues.notes].filter(Boolean).join(' · ') };
	} else if (type === 'transfer') {
		const destination = getWarehouse(values.get('destination'));
		const quantity = toBase(values.get('quantity'), values.get('unit'));
		if (!destination || destination.kind !== warehouse.kind) throw new Error('اختر مخزنًا من نفس النوع');
		if (quantity > itemBalance(material, values.get('date'))) throw new Error('الكمية أكبر من الرصيد المتاح بتاريخ الحركة');
		let destMaterial = state.materials.find(item => item.warehouse_id === destination.id && item.name.toLowerCase() === material.name.toLowerCase());
		if (!destMaterial) {
			const { data, error } = await state.client.from('materials').insert({ warehouse_id: destination.id, name: material.name, unit: material.unit, minimum_base: 0, user_id: state.session.user.id }).select().single();
			if (error) throw error;
			destMaterial = data;
		}
		const transferId = crypto.randomUUID();
		const records = [
			{ ...baseValues, quantity_base: -quantity, movement_type: 'transfer_out', transfer_ref: transferId },
			{ ...baseValues, warehouse_id: destination.id, material_id: destMaterial.id, quantity_base: quantity, movement_type: 'transfer_in', transfer_ref: transferId }
		];
		const { error } = await state.client.from('stock_movements').insert(records);
		if (error) throw error;
		closeModal(); await loadData(); toast('تم التحويل بين المخزنين'); return;
	} else {
		const quantity = toBase(values.get('quantity'), values.get('unit'));
		if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('أدخل كمية أكبر من صفر');
		const incoming = ['inbound', 'return'].includes(type);
		if (!incoming && quantity > itemBalance(material, values.get('date'))) throw new Error('الكمية أكبر من الرصيد المتاح بتاريخ الحركة');
		record = { ...baseValues, quantity_base: incoming ? quantity : -quantity, movement_type: type, supplier: type === 'inbound' ? values.get('supplier').trim() || null : null };
	}
	const { error } = await state.client.from('stock_movements').insert(record);
	if (error) throw error;
	closeModal(); await loadData(); toast('تم تسجيل الحركة');
}

async function createAccount(values) {
	const { data, error } = await state.client.auth.signUp({ email: values.get('email'), password: values.get('password') });
	if (error) throw error;
	if (!data.session) {
		closeModal();
		renderAuth('الحساب اتسجل لكن Supabase ما زال يطلب تأكيد البريد. أوقف Confirm email من Authentication > Sign In / Providers > Email. الحساب الحالي يحتاج تأكيدًا مرة واحدة أو إعادة إنشائه بعد إيقاف الخيار.');
		return;
	}
	state.session = data.session;
	closeModal();
	await loadData();
	toast('تم إنشاء الحساب وتسجيل الدخول');
}

function exportReport() {
	const rows = [['الصنف', 'المخزن', 'النوع', 'الرصيد', 'الوحدة', 'الحد الأدنى', 'الحالة']];
	for (const material of state.materials) {
		const balance = itemBalance(material, state.reportDate);
		const low = Number(material.minimum_base) > 0 && balance <= Number(material.minimum_base);
		rows.push([material.name, getWarehouse(material.warehouse_id)?.name || '', warehouseKindLabel(getWarehouse(material.warehouse_id)?.kind), (balance / (WEIGHT_UNITS[material.unit] || 1)).toString(), UNIT_LABELS[material.unit], (Number(material.minimum_base) / (WEIGHT_UNITS[material.unit] || 1)).toString(), low ? 'منخفض' : 'طبيعي']);
	}
	const csv = '\uFEFF' + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
	const link = document.createElement('a');
	link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
	link.download = `inventory-${state.reportDate}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

start();
