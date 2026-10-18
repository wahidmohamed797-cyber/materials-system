const THEME_KEY = 'raw-materials-theme';
const NOTIFICATIONS_KEY = 'raw-materials-low-stock-notifications';
const NOTIFICATIONS_SEEN_KEY = 'raw-materials-seen-stock-alerts';
const WEIGHT_UNITS = { g: 1, kg: 1000, ton: 1000000, bag: 1, pack: 1 };
const UNIT_LABELS = { g: 'جرام', kg: 'كيلو', ton: 'طن', bag: 'شكارة', pack: 'عبوة' };
const MOVEMENT_LABELS = {
	opening: 'رصيد افتتاحي', inbound: 'إضافة كمية', production_issue: 'صرف للإنتاج',
	return: 'مرتجع من الإنتاج', adjustment_in: 'تسوية زيادة', adjustment_out: 'تسوية نقص',
	transfer_in: 'تحويل وارد', transfer_out: 'تحويل صادر'
};

const app = document.querySelector('#app');
const state = {
	client: null, session: null, page: 'home', warehouseId: null, warehousesExpanded: false, issueHistoryExpanded: false, issueFormExpanded: false,
	warehouses: [], materials: [], suppliers: [], movements: [], productionIssues: [],
	returnableIssues: [], productionReturns: [], supplierDraftMaterialIds: [],
	issueClipboard: null, issueDraftMeta: { voucher: '', beneficiary: '', mixCount: '' }, issueDraftLines: [],
	filterReturnPage: 'home', filterReturnWarehouseId: null, filteredMaterialId: null, filteredMaterialIds: [],
	filteredMovements: [], materialFilterLoading: false, materialFilterError: '', focusMovementId: null,
	searchSequence: 0, searchRenderedTerm: '', filterSequence: 0,
	tableSelections: {}, tableSelectionModes: {}, pendingBulkDelete: null,
	balances: {}, reportBalances: {}, reportIssues: [],
	charts: [], trend: [], inboundLast30: 0, movementCount: 0, reportDate: today(), busy: false
};

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
	return `${formatNumber(Number(base || 0) / divisor, unit === 'g' || isCountUnit(unit) ? 0 : 3)} ${UNIT_LABELS[unit] || unit}`;
}
function toBase(quantity, unit) {
	const value = Number(quantity);
	return value * (WEIGHT_UNITS[unit] || 1);
}
function isCountUnit(unit) { return unit === 'bag' || unit === 'pack'; }
function quantityInputLabel(unit) {
	return unit === 'bag' ? 'الكمية بالشكاير' : unit === 'pack' ? 'الكمية بالعبوات' : 'الكمية بالكيلو';
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
		<button class="text-button" data-action="signup">إنشاء حساب للتجربة</button>
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

function dataLoadError(message) {
	app.innerHTML = `<main class="error-screen"><div>${icon('database-zap', 34)}<h1>تعذر تحميل بيانات النظام</h1><p>${escapeHtml(message)}</p><p class="muted">شغّل أحدث نسخة من ملف supabase.sql في SQL Editor حتى تُحفظ الأرصدة في قاعدة البيانات وليس في المتصفح فقط.</p><button class="button button-secondary" data-action="logout">تسجيل الخروج</button></div></main>`;
	document.querySelector('[data-action="logout"]')?.addEventListener('click', () => state.client.auth.signOut());
	renderIcons();
}

async function balanceAtDate(materialId, asOf) {
	const { data, error } = await state.client.rpc('material_balance_at', { p_material_id: materialId, p_as_of: asOf });
	if (error) throw error;
	return Number(data || 0);
}

async function loadReportSnapshot() {
	const [balances, count, issues] = await Promise.all([
		state.client.rpc('inventory_balances', { p_as_of: state.reportDate }),
		state.client.rpc('stock_movement_count', { p_as_of: state.reportDate }),
		state.client.from('stock_movements').select('*').eq('movement_type', 'production_issue')
			.lte('happened_at', `${state.reportDate}T23:59:59`).order('happened_at', { ascending: false }).limit(300)
	]);
	if (balances.error) throw balances.error;
	if (count.error) throw count.error;
	if (issues.error) throw issues.error;
	state.reportBalances = toBalanceMap(balances.data);
	state.movementCount = Number(count.data || 0);
	state.reportIssues = issues.data || [];
}

async function loadData() {
	if (!state.session) return;
	const trendFrom = new Date();
	trendFrom.setHours(12, 0, 0, 0);
	trendFrom.setDate(trendFrom.getDate() - 6);
	const from30 = new Date();
	from30.setDate(from30.getDate() - 30);
	const incomingTypes = ['opening', 'inbound', 'return', 'adjustment_in', 'transfer_in'];
	const results = await Promise.all([
		selectAllRows('warehouses', 'name'),
		selectAllRows('materials', 'name'),
		selectAllRows('suppliers', 'name'),
		state.client.rpc('inventory_balances', { p_as_of: today() }),
		state.client.from('stock_movements').select('*').order('happened_at', { ascending: false }).limit(40),
		state.client.rpc('movement_trend', { p_from: localDateKey(trendFrom), p_to: today() }),
		state.client.from('stock_movements').select('id', { count: 'exact', head: true }).in('movement_type', incomingTypes).gte('happened_at', from30.toISOString()),
		selectMovementsByType('production_issue'),
		state.client.rpc('production_issue_returns'),
		selectMovementsByType('return')
	]);
	const failed = results.find(result => result.error);
	if (failed) return dataLoadError(failed.error.message);
	state.warehouses = results[0].data || [];
	state.materials = results[1].data || [];
	state.suppliers = results[2].data || [];
	state.balances = toBalanceMap(results[3].data);
	state.movements = results[4].data || [];
	state.trend = results[5].data || [];
	state.inboundLast30 = results[6].count || 0;
	state.productionIssues = results[7].data || [];
	state.returnableIssues = results[8].data || [];
	if (results[9].error) return dataLoadError(results[9].error.message);
	state.productionReturns = results[9].data || [];
	if (state.reportDate === today()) {
		state.reportBalances = state.balances;
		const { data, error } = await state.client.rpc('stock_movement_count', { p_as_of: today() });
		if (error) return dataLoadError(error.message);
		state.movementCount = Number(data || 0);
	} else if (state.page === 'reports') {
		try { await loadReportSnapshot(); }
		catch (error) { return dataLoadError(error.message || 'تعذر تحميل تقرير الأرصدة'); }
	}
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

async function selectMovementsByType(type) {
	const pageSize = 1000;
	const rows = [];
	for (let start = 0; ; start += pageSize) {
		const { data, error } = await state.client.from('stock_movements').select('*')
			.eq('movement_type', type).order('happened_at', { ascending: false }).range(start, start + pageSize - 1);
		if (error) return { data: null, error };
		rows.push(...data);
		if (data.length < pageSize) return { data: rows, error: null };
	}
}

async function selectMaterialMovements(materialId) {
	const pageSize = 1000;
	const rows = [];
	for (let start = 0; ; start += pageSize) {
		const { data, error } = await state.client.from('stock_movements').select('*')
			.eq('material_id', materialId).order('happened_at', { ascending: false }).range(start, start + pageSize - 1);
		if (error) throw error;
		rows.push(...data);
		if (data.length < pageSize) return rows;
	}
}

async function openMaterialFilter(materialId, focusMovementId = null) {
	if (!getMaterial(materialId)) return toast('تعذر العثور على الصنف', 'error');
	if (state.page !== 'material-history') {
		state.filterReturnPage = state.page;
		state.filterReturnWarehouseId = state.warehouseId;
	}
	state.page = 'material-history';
	state.filteredMaterialId = materialId;
	state.filteredMaterialIds = [];
	state.filteredMovements = [];
	state.materialFilterLoading = true;
	state.materialFilterError = '';
	state.focusMovementId = focusMovementId;
	const sequence = ++state.filterSequence;
	renderApp();
	try {
		const code = normalizeCode(getMaterial(materialId).code).toLowerCase();
		const materialIds = new Set(state.materials.filter(material => normalizeCode(material.code).toLowerCase() === code).map(material => material.id));
		const movements = new Map();
		const scannedIds = new Set();
		const scannedTransfers = new Set();
		while (true) {
			const nextId = [...materialIds].find(id => !scannedIds.has(id));
			if (!nextId) break;
			scannedIds.add(nextId);
			const rows = await selectMaterialMovements(nextId);
			const transferRefs = new Set();
			for (const row of rows) {
				movements.set(row.id, row);
				if (row.transfer_ref && !scannedTransfers.has(row.transfer_ref)) transferRefs.add(row.transfer_ref);
			}
			const refs = [...transferRefs];
			for (let offset = 0; offset < refs.length; offset += 100) {
				const batch = refs.slice(offset, offset + 100);
				const { data, error } = await state.client.from('stock_movements').select('*').in('transfer_ref', batch);
				if (error) throw error;
				for (const row of data || []) {
					scannedTransfers.add(row.transfer_ref);
					movements.set(row.id, row);
					materialIds.add(row.material_id);
				}
			}
		}
		if (sequence !== state.filterSequence) return;
		state.filteredMaterialIds = [...materialIds];
		state.filteredMovements = [...movements.values()].sort((a, b) => new Date(b.happened_at) - new Date(a.happened_at));
	} catch (error) {
		if (sequence !== state.filterSequence) return;
		state.materialFilterError = error.message || 'تعذر تحميل حركات الصنف';
	} finally {
		if (sequence === state.filterSequence) {
			state.materialFilterLoading = false;
			renderApp();
			if (focusMovementId) document.querySelector(`[data-filter-movement="${CSS.escape(focusMovementId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}
}

function warehouseKindLabel(kind) { return kind === 'empties' ? 'فوارغ' : 'خامات'; }
function toBalanceMap(rows) {
	const map = {};
	for (const row of rows || []) map[row.material_id] = row;
	return map;
}
function snapshotFor(until = null) {
	return until && until !== today() ? state.reportBalances : state.balances;
}
function itemBalance(material, until = null) {
	return Number(snapshotFor(until)[material.id]?.quantity_base || 0);
}
function allocateStockByLeastBalance(stocks, quantityBase, materialName) {
	const orderedStocks = [...stocks].sort((a, b) => a.balance - b.balance);
	const totalAvailable = orderedStocks.reduce((total, stock) => total + stock.balance, 0);
	if (quantityBase > totalAvailable + 0.000000001) {
		throw new Error(`الكمية المطلوبة من ${materialName} أكبر من الرصيد المتاح في المخازن النشطة`);
	}
	const allocations = [];
	let remaining = quantityBase;
	for (const stock of orderedStocks) {
		if (remaining <= 0.000000001) break;
		if (stock.balance <= 0) continue;
		const allocated = Math.min(stock.balance, remaining);
		allocations.push({ material: stock.material, quantityBase: allocated });
		remaining -= allocated;
	}
	if (remaining > 0.000000001) {
		throw new Error(`تعذر توزيع الكمية المطلوبة من ${materialName} بالكامل`);
	}
	return allocations;
}
function lastMovementAt(material, until = null) {
	return snapshotFor(until)[material.id]?.last_happened_at || null;
}
function getWarehouse(id) { return state.warehouses.find(warehouse => warehouse.id === id); }
function getMaterial(id) { return state.materials.find(material => material.id === id); }
function findMaterialsByInput(value, warehouseIds = null) {
	const query = String(value || '').trim().toLocaleLowerCase();
	if (!query) return [];
	const candidates = state.materials.filter(material => !warehouseIds || warehouseIds.has(material.warehouse_id));
	let matches = candidates.filter(material => [material.code, `${material.name} · ${materialCode(material)}`]
		.some(candidate => String(candidate || '').trim().toLocaleLowerCase() === query));
	if (!matches.length) matches = candidates.filter(material => String(material.name || '').trim().toLocaleLowerCase() === query);
	if (!matches.length || new Set(matches.map(material => normalizeCode(material.code).toLocaleLowerCase())).size !== 1) return [];
	const identities = new Set(matches.map(material => `${material.name.trim().toLocaleLowerCase()}\u0000${material.unit}`));
	return identities.size === 1 ? matches : [];
}
function findMaterialByInput(value) { return findMaterialsByInput(value)[0] || null; }
function findWarehouseMaterialByInput(value, warehouseId) {
	const query = String(value || '').trim().toLocaleLowerCase();
	if (!query) return null;
	const matches = state.materials.filter(material => material.warehouse_id === warehouseId
		&& [material.name, materialCode(material), `${material.name} · ${materialCode(material)}`]
			.some(candidate => String(candidate || '').trim().toLocaleLowerCase() === query));
	return matches.length === 1 ? matches[0] : null;
}
function updateIssueQuantityUnit() {
	const material = findMaterialByInput(app.querySelector('#issue-form [name="material"]')?.value);
	const label = app.querySelector('#issue-quantity-unit');
	const quantity = app.querySelector('#issue-form [name="quantity"]');
	const unit = material?.unit || 'kg';
	if (label) label.textContent = quantityInputLabel(unit);
	if (quantity) quantity.step = isCountUnit(unit) ? '1' : 'any';
}
function updateReturnFormDetails() {
	const issueReference = app.querySelector('#return-issue')?.value;
	const issue = findReturnableIssue(issueReference);
	const material = issue && getMaterial(issue.material_id);
	const nameInput = app.querySelector('#return-material-name');
	const label = app.querySelector('#return-quantity-label');
	const quantity = app.querySelector('#return-quantity');
	if (nameInput) nameInput.value = material?.name || '';
	if (!quantity || !label) return;
	if (!issue || !material) {
		quantity.removeAttribute('max');
		return;
	}
	const unit = isCountUnit(material.unit) ? material.unit : 'kg';
	const remaining = Number(issue.quantity_issued) - Number(issue.quantity_returned);
	const remainingInEntryUnit = isCountUnit(unit) ? remaining : remaining / WEIGHT_UNITS.kg;
	label.textContent = quantityInputLabel(unit);
	quantity.step = isCountUnit(unit) ? '1' : 'any';
	quantity.max = String(Math.max(0, remainingInEntryUnit));
}
function getSupplier(id) { return state.suppliers.find(supplier => supplier.id === id); }
function materialCode(material) { return material?.code?.trim() || '—'; }
function materialsByCode(materials = state.materials) {
	const groups = new Map();
	for (const material of materials) {
		const code = normalizeCode(material.code).toLocaleLowerCase();
		if (!groups.has(code)) groups.set(code, []);
	groups.get(code).push(material);
	}
	return [...groups.values()];
}
function activeMaterialsByCode() {
	return materialsByCode().map(records => records.find(material => getWarehouse(material.warehouse_id)?.is_open !== false)).filter(Boolean);
}
function supplierMaterials(supplier) {
	const supplierName = supplier?.name?.trim().toLocaleLowerCase();
	return state.materials.filter(material => material.supplier_id === supplier?.id
		|| (!material.supplier_id && String(material.supplier || '').trim().toLocaleLowerCase() === supplierName));
}
function supplierMaterialLabels(supplier) {
	return supplierMaterials(supplier).map(material => `${materialCode(material)} · ${material.name}`).join('، ') || '—';
}
function materialLabel(material) {
	if (!material) return '';
	const warehouse = getWarehouse(material.warehouse_id)?.name || '';
	return `${materialCode(material)} · ${material.name}${warehouse ? ` · ${warehouse}` : ''}`;
}
function normalizeCode(value) { return String(value || '').trim(); }
function codeTaken(code, exceptId = null, warehouseId = null) {
	const key = normalizeCode(code).toLowerCase();
	return state.materials.some(item => item.id !== exceptId
		&& (!warehouseId || item.warehouse_id === warehouseId)
		&& normalizeCode(item.code).toLowerCase() === key);
}
function supplierOptions(selected = '') {
	const supplier = getSupplier(selected);
	const value = supplier?.name || selected;
	const options = state.suppliers.map(item => `<option value="${escapeHtml(item.name)}"></option>`).join('');
	return `<input name="supplier" list="supplier-options" value="${escapeHtml(value)}" placeholder="اكتب اسم المورد أو اختره" autocomplete="off"><datalist id="supplier-options">${options}</datalist>`;
}
function materialSupplier(material, until = null) {
	return snapshotFor(until)[material.id]?.supplier
		|| getSupplier(material.supplier_id)?.name
		|| material.supplier?.trim()
		|| '—';
}
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
	if (state.page === 'material-history') return 'تصفية الصنف';
	return ({ home: 'الرئيسية', warehouses: 'المخازن', inventory: 'إجمالي الأصناف', empties: 'الفوارغ', issue: 'صرف للإنتاج', returns: 'مرتجعات الإنتاج', suppliers: 'الموردين', reports: 'التقارير', settings: 'الإعدادات' })[state.page] || 'الرئيسية';
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
				${navLink('inventory', 'clipboard-list', 'إجمالي الأصناف')}
				${navLink('empties', 'package-open', 'الفوارغ')}
				${navLink('issue', 'factory', 'صرف للإنتاج')}
				${navLink('returns', 'corner-down-left', 'مرتجعات الإنتاج')}
				${navLink('suppliers', 'handshake', 'الموردين')}
				${navLink('reports', 'chart-no-axes-combined', 'التقارير')}
				${navLink('settings', 'settings-2', 'الإعدادات')}
			</nav>
			<button class="mobile-nav-arrow mobile-nav-previous" data-nav-scroll="-1" aria-label="الصفحات السابقة" title="الصفحات السابقة">${icon('chevron-right', 17)}</button>
			<button class="mobile-nav-arrow mobile-nav-next" data-nav-scroll="1" aria-label="صفحات إضافية" title="صفحات إضافية">${icon('chevron-left', 17)}</button>
			<div class="sidebar-bottom"><div class="connection"><span class="connection-dot"></span><span>قاعدة البيانات متصلة</span></div>
				<button class="button button-add-warehouse" data-action="add-warehouse">${icon('plus')}<span>إضافة مخزن</span></button>
			</div>
		</aside>
		<main class="main-area">
			<header class="topbar"><div><p class="breadcrumb">إدارة المخزون <span>/</span> ${escapeHtml(pageTitle())}</p><h1>${escapeHtml(pageTitle())}</h1></div>
				${state.page === 'material-history' ? `<button class="page-back" data-action="clear-material-filter" aria-label="إنهاء التصفية" title="إنهاء التصفية">${icon('x', 19)}<span>إنهاء التصفية</span></button>` : state.page !== 'home' ? `<button class="page-back" data-action="back-home" aria-label="العودة للرئيسية" title="العودة للرئيسية">${icon('arrow-left', 19)}<span>الرئيسية</span></button>` : ''}
				<div class="top-actions">
					<div class="search-wrap"><label class="global-search">${icon('search')}<input id="global-search" type="search" placeholder="ابحث عن صنف أو كود أو مورد أو إذن" autocomplete="off" aria-label="ابحث عن صنف أو كود أو مورد أو إذن"><kbd>/</kbd></label><div id="search-results" class="popover search-popover" hidden></div></div>
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
	if (state.page === 'material-history') return renderMaterialHistory();
	if (state.page === 'warehouses') return renderWarehouses('raw');
	if (state.page === 'inventory') return renderInventoryTotals();
	if (state.page === 'empties') return renderWarehouses('empties');
	if (state.page === 'warehouse' && warehouse) return renderWarehouse(warehouse);
	if (state.page === 'issue') return renderIssuePage();
	if (state.page === 'returns') return renderReturnsPage();
	if (state.page === 'suppliers') return renderSuppliersPage();
	if (state.page === 'reports') return renderReports();
	if (state.page === 'settings') return renderSettings();
	return renderDashboard();
}

function renderDashboard() {
	const activeWarehouses = state.warehouses.filter(warehouse => warehouse.is_open !== false).length;
	const additions = state.inboundLast30;
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
	const trendByDay = Object.fromEntries((state.trend || []).map(row => [String(row.day).slice(0, 10), row]));
	const incoming = days.map(day => Number(trendByDay[day.key]?.incoming || 0));
	const outgoing = days.map(day => Number(trendByDay[day.key]?.outgoing || 0));
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
	const stateLabel = warehouse.is_open === false ? 'مغلق' : 'نشط';
	return `<button class="warehouse-card" data-open-warehouse="${warehouse.id}"><span class="warehouse-icon ${warehouse.kind === 'empties' ? 'empty-icon' : ''}">${icon(warehouse.kind === 'empties' ? 'package-open' : 'warehouse')}</span><span class="warehouse-card-copy"><b>${escapeHtml(warehouse.name)}</b><small>${warehouseKindLabel(warehouse.kind)} · ${formatNumber(count, 0)} أصناف · ${stateLabel}</small></span>${icon('arrow-up-left', 17)}</button>`;
}

function warehouseNavGroup() {
	const active = state.page === 'warehouses' || state.page === 'warehouse';
	const subItems = state.warehouses.length
		? state.warehouses.map(warehouse => `<button class="side-sub-link ${state.page === 'warehouse' && state.warehouseId === warehouse.id ? 'active' : ''}" data-open-warehouse="${warehouse.id}"><span class="sub-link-dot ${warehouse.kind === 'empties' ? 'empty-dot' : ''}"></span><span>${escapeHtml(warehouse.name)}</span><small>${warehouse.is_open === false ? 'مغلق' : 'نشط'}</small></button>`).join('')
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
	return `<div class="section-intro"><div><h2>${escapeHtml(warehouse.name)}</h2><span class="kind-badge ${isEmpties ? 'kind-empty' : ''}">${warehouseKindLabel(warehouse.kind)} · ${warehouse.is_open === false ? 'مغلق' : 'نشط'}</span></div><div class="inline-actions"><button class="button button-small ${warehouse.is_open === false ? 'button-primary' : 'button-secondary'}" data-action="toggle-warehouse-state" data-warehouse="${warehouse.id}" aria-pressed="${warehouse.is_open !== false}">${icon(warehouse.is_open === false ? 'lock-keyhole-open' : 'lock-keyhole')} ${warehouse.is_open === false ? 'فتح المخزن' : 'إغلاق المخزن'}</button><button class="button button-danger-outline" data-action="delete-warehouse" data-warehouse="${warehouse.id}">${icon('trash-2')} حذف المخزن</button><button class="button button-secondary" data-action="movement" data-warehouse="${warehouse.id}">${icon('repeat-2')} حركة مخزون</button><button class="button button-primary" data-action="add-material" data-warehouse="${warehouse.id}">${icon('plus')} إضافة صنف</button></div></div>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">الرصيد الحالي</p><h3>الأصناف في المخزن</h3></div><span class="quiet-badge">${formatNumber(materials.length, 0)} أصناف</span></div>
		${materials.length ? `<div class="table-scroll"><table><thead><tr><th>الكود</th><th>اسم الصنف</th><th>المورد</th><th>الرصيد الحالي</th><th>الحد الأدنى</th><th>آخر حركة</th><th>الحالة</th><th></th></tr></thead><tbody>${materials.map(material => materialTableRow(material)).join('')}</tbody></table></div>` : emptyState(isEmpties ? 'package-open' : 'flask-conical', 'المخزن فارغ حتى الآن', 'أضف صنفًا وسجل رصيده الافتتاحي للبدء.')}</section>`;
}

function renderInventoryTotals() {
	const materials = materialsByCode().map(records => ({
		material: records[0],
		records,
		balance: records.reduce((total, material) => total + itemBalance(material), 0),
		minimum: records.reduce((total, material) => total + Number(material.minimum_base || 0), 0)
	})).sort((a, b) => materialCode(a.material).localeCompare(materialCode(b.material), 'ar', { numeric: true, sensitivity: 'base' }));
	const stockedCount = materials.filter(item => item.balance > 0).length;
	const totalBags = state.materials.reduce((total, material) => total + (material.unit === 'bag' ? itemBalance(material) : 0), 0);
	return `<div class="section-intro"><div><p class="eyebrow">جرد شامل</p><h2>إجمالي الأصناف</h2><p class="muted">الأرصدة الحالية الفعلية لكل كود في جميع المخازن.</p></div></div>
		<div class="report-summary inventory-summary"><div class="report-stat">${icon('scan-barcode')}<span>أكواد أصناف مسجلة</span><b>${formatNumber(materials.length, 0)}</b></div><div class="report-stat">${icon('package-check')}<span>أصناف لها رصيد</span><b>${formatNumber(stockedCount, 0)}</b></div><div class="report-stat"><span>إجمالي الشكاير</span><b>${formatNumber(totalBags, 0)}</b></div></div>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">الرصيد المتاح الآن</p><h3>الأصناف والأكواد</h3></div><span class="quiet-badge">${formatNumber(materials.length, 0)} صنف</span></div>
		${materials.length ? `<div class="table-scroll"><table><thead><tr><th>كود الصنف</th><th>اسم الصنف</th><th>الأرصدة حسب المخزن</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>${materials.map(({ material, records, balance, minimum }) => {
			const status = balance <= 0 ? 'نفد' : minimum > 0 && balance <= minimum ? 'منخفض' : 'متاح';
			const distribution = records.map(record => `${escapeHtml(getWarehouse(record.warehouse_id)?.name || 'مخزن')}: ${displayAmount(itemBalance(record), material.unit)}`).join('<br>');
			return `<tr><td class="amount-cell">${escapeHtml(materialCode(material))}</td><td><b class="table-primary">${escapeHtml(material.name)}</b></td><td>${distribution}</td><td class="amount-cell">${displayAmount(balance, material.unit)}</td><td><span class="status ${status === 'متاح' ? 'status-ok' : 'status-low'}">${status}</span></td></tr>`;
		}).join('')}</tbody></table></div>` : emptyState('boxes', 'لا توجد أصناف مسجلة', 'أضف أصنافًا إلى مخازنك لعرض أرصدتها هنا.')}</section>`;
}

function renderMaterialHistory() {
	const material = getMaterial(state.filteredMaterialId);
	if (!material) return emptyState('package-search', 'الصنف غير موجود', 'قد يكون الصنف حُذف من المخزون.');
	const relatedMaterials = state.filteredMaterialIds.map(getMaterial).filter(Boolean);
	const totalBalance = state.filteredMaterialIds.reduce((total, id) => total + Number(state.balances[id]?.quantity_base || 0), 0);
	const returned = state.filteredMovements.filter(movement => movement.movement_type === 'return')
		.reduce((total, movement) => total + Number(movement.quantity_base || 0), 0);
	return `<div class="section-intro"><div><p class="eyebrow">نتائج التصفية</p><h2>${escapeHtml(material.name)}</h2><p class="muted">كود ${escapeHtml(materialCode(material))} · ${formatNumber(relatedMaterials.length, 0)} سجل صنف بين المخازن</p></div></div>
		<div class="report-summary inventory-summary"><div class="report-stat">${icon('scan-barcode')}<span>كود الصنف</span><b>${escapeHtml(materialCode(material))}</b></div><div class="report-stat">${icon('package-check')}<span>الرصيد الحالي في المخازن المرتبطة</span><b>${displayAmount(totalBalance, material.unit)}</b></div><div class="report-stat">${icon('list-checks')}<span>عدد الحركات</span><b>${formatNumber(state.filteredMovements.length, 0)}</b></div><div class="report-stat">${icon('corner-down-left')}<span>إجمالي المرتجع</span><b>${displayAmount(returned, material.unit)}</b></div></div>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">كل التواريخ</p><h3>سجل حركات الصنف المرتبط</h3></div><span class="quiet-badge">${formatNumber(state.filteredMovements.length, 0)} حركة</span></div>
		${state.materialFilterLoading ? emptyState('loader-circle', 'جارٍ تحميل الحركات', 'يتم جمع الحركات من كل التواريخ والمخازن المرتبطة.') : state.materialFilterError ? emptyState('triangle-alert', 'تعذر تحميل الحركات', state.materialFilterError) : state.filteredMovements.length ? `<div class="table-scroll"><table><thead><tr><th>التاريخ</th><th>نوع الحركة</th><th>المخزن</th><th>رقم المستند أو المستفيد</th><th>الكمية</th><th>ملاحظات</th></tr></thead><tbody>${state.filteredMovements.map(materialHistoryRow).join('')}</tbody></table></div>` : emptyState('activity', 'لا توجد حركات مسجلة', 'لا يوجد سجل حركات لهذا الصنف حتى الآن.')}
		</section>`;
}

function materialHistoryRow(movement) {
	const material = getMaterial(movement.material_id);
	const quantity = Number(movement.quantity_base);
	const isIncoming = quantity > 0;
	const unit = material?.unit || getMaterial(state.filteredMaterialId)?.unit || 'kg';
	const documentRef = movement.movement_type === 'production_issue'
		? `إذن ${movement.voucher_no || '—'} · ${movement.beneficiary || '—'}`
		: movement.movement_type === 'return'
			? `مرتجع إذن ${movement.voucher_no || '—'}`
			: movement.voucher_no || movement.supplier || (movement.transfer_ref ? 'تحويل بين المخازن' : '—');
	const rowClass = movement.id === state.focusMovementId ? ' class="filter-match-row"' : '';
	return `<tr${rowClass} data-filter-movement="${escapeHtml(movement.id)}" data-select-kind="movement" data-select-id="${escapeHtml(movement.id)}"><td>${formatDate(movement.happened_at)}</td><td>${escapeHtml(MOVEMENT_LABELS[movement.movement_type] || 'حركة')}</td><td>${escapeHtml(getWarehouse(movement.warehouse_id)?.name || '—')}</td><td>${escapeHtml(documentRef)}</td><td class="amount-cell ${isIncoming ? 'positive' : 'negative'}">${isIncoming ? '+' : '−'} ${displayAmount(Math.abs(quantity), unit)}</td><td>${escapeHtml(movement.notes || '—')}</td></tr>`;
}

function materialTableRow(material, balance = itemBalance(material), atDate = null) {
	const minimum = Number(material.minimum_base || 0);
	const low = minimum > 0 && balance <= minimum;
	const last = lastMovementAt(material, atDate);
	return `<tr data-select-kind="material" data-select-id="${material.id}"><td class="amount-cell">${escapeHtml(materialCode(material))}</td><td><b class="table-primary">${escapeHtml(material.name)}</b></td><td>${escapeHtml(materialSupplier(material, atDate))}</td><td class="amount-cell">${displayAmount(balance, material.unit)}</td><td>${minimum ? displayAmount(minimum, material.unit) : 'غير محدد'}</td><td>${last ? formatDate(last) : '—'}</td><td><span class="status ${low ? 'status-low' : 'status-ok'}">${low ? 'منخفض' : 'طبيعي'}</span></td><td><button class="icon-button row-action" data-action="movement" data-warehouse="${material.warehouse_id}" data-material="${material.id}" title="تسجيل حركة">${icon('plus')}</button><button class="icon-button row-action" data-action="edit-material" data-material="${material.id}" title="تعديل الصنف">${icon('pencil')}</button><button class="row-delete-button" data-action="delete-material" data-material="${material.id}" title="حذف الصنف">${icon('trash-2')}<span>حذف</span></button></td></tr>`;
}

function renderReports() {
	const rows = state.materials.map(material => ({ material, balance: itemBalance(material, state.reportDate) }));
	const low = rows.filter(({ material, balance }) => Number(material.minimum_base) > 0 && balance <= Number(material.minimum_base));
	const movementRowsCount = state.movementCount;
	return `<div class="section-intro"><div><p class="eyebrow">مراجعة الأرصدة</p><h2>التقارير</h2><p class="muted">استعرض أرصدة الأصناف كما كانت في تاريخ محدد.</p></div><div class="report-controls"><label>الرصيد حتى تاريخ<input id="report-date" type="date" value="${state.reportDate}" max="${today()}"></label><button class="button button-secondary" data-action="export-report">${icon('file-down')} تصدير CSV</button></div></div>
		<div class="report-summary"><div class="report-stat">${icon('boxes')}<span>الأصناف</span><b>${formatNumber(rows.length, 0)}</b></div><div class="report-stat warning-stat">${icon('triangle-alert')}<span>تحت الحد الأدنى</span><b>${formatNumber(low.length, 0)}</b></div><div class="report-stat">${icon('activity')}<span>إجمالي الحركات حتى التاريخ</span><b>${formatNumber(movementRowsCount, 0)}</b></div></div>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">جرد تاريخي</p><h3>الأرصدة في ${formatDate(state.reportDate)}</h3></div><span class="quiet-badge">${formatNumber(rows.length, 0)} صنف</span></div>
		${rows.length ? `<div class="table-scroll"><table><thead><tr><th>الكود</th><th>الصنف</th><th>المورد</th><th>المخزن</th><th>الرصيد بالتاريخ المحدد</th><th>الحد الأدنى</th><th>الحالة</th><th>آخر حركة حتى التاريخ</th></tr></thead><tbody>${rows.map(({ material, balance }) => {
			const minimum = Number(material.minimum_base || 0);
			const isLow = minimum > 0 && balance <= minimum;
			const last = lastMovementAt(material, state.reportDate);
			return `<tr data-select-kind="material" data-select-id="${material.id}"><td>${escapeHtml(materialCode(material))}</td><td><b class="table-primary">${escapeHtml(material.name)}</b></td><td>${escapeHtml(materialSupplier(material, state.reportDate))}</td><td>${escapeHtml(getWarehouse(material.warehouse_id)?.name || '')}</td><td class="amount-cell">${displayAmount(balance, material.unit)}</td><td>${minimum ? displayAmount(minimum, material.unit) : '—'}</td><td><span class="status ${isLow ? 'status-low' : 'status-ok'}">${isLow ? 'منخفض' : 'طبيعي'}</span></td><td>${last ? formatDate(last) : '—'}</td></tr>`;
		}).join('')}</tbody></table></div>` : emptyState('file-chart-column', 'لا توجد بيانات للتقرير', 'أضف مخزنًا وأصنافًا لتظهر الأرصدة هنا.')}</section>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">صرف الإنتاج</p><h3>أذون الصرف حتى ${formatDate(state.reportDate)}</h3></div><span class="quiet-badge">${formatNumber((state.reportIssues || []).length, 0)} إذن</span></div>
			${(state.reportIssues || []).length ? `<div class="table-scroll"><table><thead><tr><th>رقم الإذن</th><th>المستفيد</th><th>عدد الخلطات</th><th>الكود</th><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>التاريخ</th></tr></thead><tbody>${state.reportIssues.map(issueReportRow).join('')}</tbody></table></div>` : emptyState('factory', 'لا توجد أذون صرف حتى هذا التاريخ', 'ستظهر أذون صرف الإنتاج هنا بعد تسجيلها.')}
		</section>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">الموردون</p><h3>الموردون المرتبطون بالأصناف</h3></div><span class="quiet-badge">${formatNumber(state.suppliers.length, 0)} مورد</span></div>
			${state.suppliers.length ? `<div class="table-scroll"><table><thead><tr><th>المورد</th><th>الأصناف التي يوردها</th><th>ملاحظات</th></tr></thead><tbody>${state.suppliers.map(supplier => `<tr data-select-kind="supplier" data-select-id="${supplier.id}"><td><b class="table-primary">${escapeHtml(supplier.name)}</b></td><td>${escapeHtml(supplierMaterialLabels(supplier))}</td><td>${escapeHtml(supplier.notes || '—')}</td></tr>`).join('')}</tbody></table></div>` : emptyState('handshake', 'لا يوجد موردون مسجلون', 'أضف موردين من صفحة الموردين لربطهم بالأصناف والاستلام.')}
		</section>
		${low.length ? `<section class="panel low-panel"><div class="panel-heading"><div><p class="eyebrow">تنبيه مخزون</p><h3>أصناف تحت الحد الأدنى</h3></div><span class="status status-low">${formatNumber(low.length, 0)} أصناف</span></div><div class="table-scroll"><table><thead><tr><th>الكود</th><th>الصنف</th><th>المورد</th><th>المخزن</th><th>الرصيد</th><th>الحد الأدنى</th></tr></thead><tbody>${low.map(({ material, balance }) => `<tr data-select-kind="material" data-select-id="${material.id}"><td>${escapeHtml(materialCode(material))}</td><td>${escapeHtml(material.name)}</td><td>${escapeHtml(materialSupplier(material, state.reportDate))}</td><td>${escapeHtml(getWarehouse(material.warehouse_id)?.name || '')}</td><td>${displayAmount(balance, material.unit)}</td><td>${displayAmount(material.minimum_base, material.unit)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
}

function renderSettings() {
	const dark = localStorage.getItem(THEME_KEY) === 'dark';
	const lowAlerts = notificationsEnabled();
	return `<div class="section-intro"><div><p class="eyebrow">تخصيص مساحة العمل</p><h2>الإعدادات</h2><p class="muted">تحكم في طريقة عرض النظام والتنبيهات.</p></div></div>
		<div class="settings-page-grid"><section class="panel settings-page-panel"><div class="panel-heading"><div><p class="eyebrow">المظهر</p><h3>ألوان مساحة العمل</h3></div>${icon('sun-moon', 20)}</div><p class="settings-description">اختر المظهر المناسب لاستخدامك. سيتم حفظ اختيارك على هذا الجهاز.</p><div class="segmented-control page-theme-control"><button class="segment-option ${dark ? '' : 'selected'}" data-theme-choice="light">${icon('sun', 15)} فاتح</button><button class="segment-option ${dark ? 'selected' : ''}" data-theme-choice="dark">${icon('moon', 15)} داكن</button></div></section>
		<section class="panel settings-page-panel"><div class="panel-heading"><div><p class="eyebrow">الإشعارات</p><h3>تنبيهات المخزون</h3></div>${icon('bell-ring', 20)}</div><div class="settings-row settings-page-row"><div class="settings-label"><span class="settings-symbol">${icon('triangle-alert')}</span><span><b>انخفاض الكمية</b><small>اعرض إشعارًا عندما يصل رصيد صنف إلى حده الأدنى أو أقل.</small></span></div><label class="switch-control"><input id="low-stock-alert-setting" type="checkbox" ${lowAlerts ? 'checked' : ''}><span class="switch-track"></span></label></div></section>
		<section class="panel settings-page-panel account-settings-panel"><div class="panel-heading"><div><p class="eyebrow">الحساب</p><h3>الملف الشخصي</h3></div>${icon('user-round', 20)}</div><div class="settings-account"><span class="avatar">${escapeHtml((state.session?.user?.email || 'م').slice(0, 1).toUpperCase())}</span><span><small>البريد المسجل</small><b>${escapeHtml(state.session?.user?.email || '')}</b></span></div><p class="settings-description">إدارة بيانات الدخول تتم من حساب المصادقة المرتبط بمشروع Supabase.</p><button class="button button-danger-outline settings-logout" data-action="logout">${icon('log-out')} تسجيل الخروج</button></section></div>`;
}

function issueReportRow(movement, showReturned = false) {
	const material = getMaterial(movement.material_id);
	const unit = isCountUnit(material?.unit) ? material.unit : 'kg';
	const returned = state.returnableIssues.find(issue => issue.issue_id === movement.id)?.quantity_returned || 0;
	return `<tr data-select-kind="movement" data-select-id="${movement.id}"><td>${escapeHtml(movement.voucher_no || '—')}</td><td>${escapeHtml(movement.beneficiary || '—')}</td><td>${movement.mix_count ? formatNumber(movement.mix_count, 0) : '—'}</td><td>${escapeHtml(materialCode(material))}</td><td>${escapeHtml(material?.name || 'صنف محذوف')}</td><td>${escapeHtml(getWarehouse(movement.warehouse_id)?.name || '—')}</td><td class="amount-cell">${material ? displayAmount(Math.abs(Number(movement.quantity_base)), unit) : '—'}</td>${showReturned ? `<td class="amount-cell">${material ? displayAmount(returned, unit) : '—'}</td>` : ''}<td>${formatDate(movement.happened_at)}</td></tr>`;
}

function newIssueDraftLine(material = '', quantity = '') {
	return { key: crypto.randomUUID(), material, quantity };
}

function captureIssueDraft() {
	const form = app.querySelector('#issue-form');
	if (!form) return;
	state.issueDraftMeta = {
		voucher: form.elements.voucher.value,
		beneficiary: form.elements.beneficiary.value,
		mixCount: form.elements.mix_count.value
	};
	state.issueDraftLines = [...form.querySelectorAll('#issue-lines > [data-issue-line]')].map(row => ({
		key: row.dataset.issueLine,
		material: row.querySelector('[data-issue-material]').value,
		quantity: row.querySelector('[data-issue-quantity]').value
	}));
}

function copyIssueDraft() {
	captureIssueDraft();
	const { voucher, beneficiary, mixCount } = state.issueDraftMeta;
	if (!voucher.trim() || !beneficiary.trim() || !Number.isInteger(Number(mixCount)) || Number(mixCount) <= 0) {
		toast('أكمل رقم الإذن والمستفيد وعدد الخلطات قبل النسخ', 'error');
		return false;
	}
	const lines = state.issueDraftLines.map((line, index) => {
		const material = findMaterialByInput(line.material);
		const quantity = Number(line.quantity);
		if (!material) throw new Error(`اختر صنفًا موجودًا للسطر ${index + 1}`);
		if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`أدخل كمية صحيحة للصنف ${material.name}`);
		if (isCountUnit(material.unit) && !Number.isInteger(quantity)) throw new Error(`كمية ${UNIT_LABELS[material.unit]} للصنف ${material.name} يجب أن تكون رقمًا صحيحًا`);
		return { material: material.code || material.name, quantity: String(quantity) };
	});
	if (new Set(lines.map(line => findMaterialByInput(line.material)?.id)).size !== lines.length) {
		toast('لا تكرر الصنف في الإذن؛ عدّل كميته في سطر واحد', 'error');
		return false;
	}
	state.issueClipboard = { voucher, beneficiary, mixCount, lines };
	toast(`تم نسخ مسودة الإذن بكل أصنافه (${formatNumber(lines.length, 0)})`);
	return true;
}

function updateIssueLineUnit(row) {
	if (!row) return;
	const material = findMaterialByInput(row.querySelector('[data-issue-material]')?.value);
	const unit = material?.unit || 'kg';
	const label = row.querySelector('[data-issue-quantity-label]');
	const quantity = row.querySelector('[data-issue-quantity]');
	if (label) label.textContent = quantityInputLabel(unit);
	if (quantity) {
		quantity.step = isCountUnit(unit) ? '1' : 'any';
		quantity.min = isCountUnit(unit) ? '1' : '0.000001';
	}
}

function productionIssueGroups() {
	const groups = new Map();
	for (const issue of state.productionIssues) {
		const key = productionIssueGroupKey(issue);
		if (!groups.has(key)) groups.set(key, { key, rows: [], voucher: issue.voucher_no || '', beneficiary: issue.beneficiary || '', mixCount: issue.mix_count || '', happenedAt: issue.happened_at });
		groups.get(key).rows.push(issue);
	}
	return [...groups.values()].sort((a, b) => new Date(b.happenedAt) - new Date(a.happenedAt));
}

function productionIssueGroupKey(issue) { return issue.issue_group_id || `legacy:${issue.id}`; }

function pasteProductionIssue() {
	if (!state.issueClipboard?.lines.length) return toast('لا يوجد إذن منسوخ للصقه', 'error');
	state.issueDraftMeta = {
		voucher: state.issueClipboard.voucher,
		beneficiary: state.issueClipboard.beneficiary,
		mixCount: String(state.issueClipboard.mixCount || '')
	};
	state.issueDraftLines = state.issueClipboard.lines.map(line => newIssueDraftLine(line.material, line.quantity));
	state.issueFormExpanded = true;
	renderApp();
	app.querySelector('#issue-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function productionIssueLineRow(issue, group, index) {
	const material = getMaterial(issue.material_id);
	const unit = isCountUnit(material?.unit) ? material.unit : 'kg';
	const returned = state.returnableIssues.find(item => item.issue_id === issue.id)?.quantity_returned || 0;
	return `<tr data-select-kind="movement" data-select-id="${escapeHtml(issue.id)}" data-issue-group="${escapeHtml(group.key)}"><td>${escapeHtml(group.voucher || '—')}</td><td>${escapeHtml(group.beneficiary || '—')}</td><td>${group.mixCount ? formatNumber(group.mixCount, 0) : '—'}</td><td>${escapeHtml(materialCode(material))}</td><td>${escapeHtml(material?.name || 'صنف محذوف')}</td><td>${escapeHtml(getWarehouse(issue.warehouse_id)?.name || '—')}</td><td class="amount-cell">${material ? displayAmount(Math.abs(Number(issue.quantity_base)), unit) : '—'}</td><td class="amount-cell">${material ? displayAmount(returned, unit) : '—'}</td><td>${formatDate(issue.happened_at)}</td></tr>`;
}

function renderIssuePage() {
	if (state.issueFormExpanded && !state.issueDraftLines.length) state.issueDraftLines = [newIssueDraftLine()];
	const materials = activeMaterialsByCode();
	const activeWarehouseNames = state.warehouses.filter(warehouse => warehouse.is_open !== false).map(warehouse => warehouse.name);
	const groupedIssues = productionIssueGroups();
	return `<div class="section-intro"><div><p class="eyebrow">إنتاج</p><h2>صرف للإنتاج</h2><p class="muted">إذن واحد يمكن أن يضم عدة أصناف بكمياتها الإجمالية وعدد الخلطات.</p></div><div class="inline-actions"><button class="button ${state.issueFormExpanded ? 'button-secondary' : 'button-primary'}" data-action="toggle-issue-form" aria-expanded="${state.issueFormExpanded}">${icon(state.issueFormExpanded ? 'eye-off' : 'factory')} ${state.issueFormExpanded ? 'إخفاء نموذج الصرف' : 'صرف'}</button><button class="button button-secondary" data-action="toggle-issue-history" aria-expanded="${state.issueHistoryExpanded}">${icon(state.issueHistoryExpanded ? 'eye-off' : 'history')} ${state.issueHistoryExpanded ? 'إخفاء سجل الصرف' : 'عرض سجل الصرف'}</button></div></div>
		${state.issueFormExpanded ? `<section class="panel work-form-panel"><form id="issue-form" class="form-stack" data-form="production-issue">
			${state.issueClipboard ? `<div class="issue-clipboard-bar"><span>${icon('clipboard-check')} تم نسخ ${formatNumber(state.issueClipboard.lines.length, 0)} أصناف كمسودة جديدة</span></div>` : ''}
			<div class="form-grid"><label>رقم الإذن<input name="voucher" maxlength="40" value="${escapeHtml(state.issueDraftMeta.voucher)}" placeholder="مثال: 142" required></label><label>المستفيد<input name="beneficiary" maxlength="120" value="${escapeHtml(state.issueDraftMeta.beneficiary)}" placeholder="خط الإنتاج" required></label><label>عدد الخلطات<input name="mix_count" type="number" min="1" step="1" value="${escapeHtml(state.issueDraftMeta.mixCount)}" required></label></div>
			<div id="issue-lines" class="issue-lines">${state.issueDraftLines.map((line, index) => {
				const material = findMaterialByInput(line.material);
				const unit = material?.unit || 'kg';
				const listId = `issue-materials-${line.key}`;
				return `<div class="issue-line-row" data-issue-line="${escapeHtml(line.key)}"><label>الصنف<input name="material" data-issue-material list="${listId}" value="${escapeHtml(material ? `${material.name} · ${materialCode(material)}` : line.material)}" placeholder="اكتب اسم الصنف أو كوده" autocomplete="off" required><datalist id="${escapeHtml(listId)}">${materials.map(item => `<option value="${escapeHtml(`${item.name} · ${materialCode(item)}`)}"></option>`).join('')}</datalist></label><label><span data-issue-quantity-label>${quantityInputLabel(unit)}</span><input name="quantity" data-issue-quantity type="number" min="${isCountUnit(unit) ? '1' : '0.000001'}" step="${isCountUnit(unit) ? '1' : 'any'}" value="${escapeHtml(line.quantity)}" required></label><button type="button" class="icon-button remove-issue-line" data-action="remove-issue-line" data-issue-line="${escapeHtml(line.key)}" aria-label="حذف الصنف من الإذن">${icon('trash-2')}</button></div>`;
			}).join('')}</div>
			<button type="button" class="button button-secondary issue-add-line" data-action="add-issue-line">${icon('plus')} إضافة صنف آخر</button>
			<div class="form-grid"><label>التاريخ<input value="${formatDate(today())}" readonly></label><p class="form-hint date-hint">تُسجل كل الأصناف بتاريخ اليوم. الكميات المدخلة إجمالية ولا تُضرب في عدد الخلطات.</p></div>
			<p class="form-hint">الصرف من المخازن النشطة فقط، ويبدأ بالمخزن الأقل رصيدًا: ${escapeHtml(activeWarehouseNames.join('، ') || 'لا توجد مخازن نشطة')}.</p>
			<div class="modal-actions issue-submit-actions"><button class="button button-secondary" type="button" data-action="copy-issue-draft" ${materials.length ? '' : 'disabled'}>${icon('copy')} نسخ المسودة</button><button class="button button-secondary" type="button" data-action="paste-production-issue" ${state.issueClipboard ? '' : 'disabled'}>${icon('clipboard-paste')} لصق المسودة</button><button class="button button-primary" type="submit" ${materials.length ? '' : 'disabled'}>صرف الإذن بكل أصنافه ${icon('factory')}</button></div>
		</form></section>` : ''}
		${state.issueHistoryExpanded ? `<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">السجل</p><h3>أذون الصرف وأصنافها</h3></div><span class="quiet-badge">${formatNumber(state.productionIssues.length, 0)} صنف مصروف</span></div>
			${state.productionIssues.length ? `<div class="table-scroll"><table id="production-issue-history"><thead><tr><th>رقم الإذن</th><th>المستفيد</th><th>عدد الخلطات</th><th>الكود</th><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>المرتجع</th><th>التاريخ</th></tr></thead><tbody>${groupedIssues.flatMap(group => group.rows.map((issue, index) => productionIssueLineRow(issue, group, index))).join('')}</tbody></table></div>` : emptyState('factory', 'لا توجد أذون صرف بعد', 'سجّل أول إذن بكل أصنافه من نموذج الصرف.')}
		</section>` : ''}`;
}

function renderReturnsPage() {
	const returnable = state.returnableIssues.filter(issue => Number(issue.quantity_issued) - Number(issue.quantity_returned) > 0);
	return `<div class="section-intro"><div><p class="eyebrow">حركة الإنتاج</p><h2>مرتجعات الإنتاج</h2><p class="muted">سجّل المرتجع على إذن الصرف وخط الإنتاج الأصلي؛ لا يمكن تجاوز الكمية المتبقية.</p></div></div>
		<section class="panel work-form-panel"><form id="return-form" class="form-stack" data-form="production-return">
			<div class="form-grid"><label>رقم إذن الصرف<input id="return-issue" name="issue_reference" list="return-issue-options" placeholder="اكتب رقم الإذن أو اختر اقتراحًا" autocomplete="off" required><datalist id="return-issue-options">${returnable.map(issue => {
				const material = getMaterial(issue.material_id);
				const unit = isCountUnit(material?.unit) ? material.unit : 'kg';
				const remaining = Number(issue.quantity_issued) - Number(issue.quantity_returned);
				return `<option value="${escapeHtml(returnIssueReference(issue))}" label="${escapeHtml(material?.name || 'صنف محذوف')} · ${escapeHtml(issue.beneficiary || 'خط غير محدد')} · متبقي ${displayAmount(remaining, unit)}"></option>`;
			}).join('')}</datalist></label><label>اسم الصنف<input id="return-material-name" readonly placeholder="يظهر بعد اختيار إذن الصرف"></label></div>
			<div class="form-grid"><label>خط الإنتاج<input name="return_line" maxlength="120" placeholder="اكتب اسم الخط المستلم للمرتجع" required></label><label><span id="return-quantity-label">الكمية بالكيلو</span><input id="return-quantity" name="quantity" type="number" min="0.000001" step="any" required></label></div>
			<div class="form-grid"><label>التاريخ<input value="${formatDate(today())}" readonly></label><p class="form-hint date-hint">يُسجل المرتجع تلقائيًا بتاريخ اليوم.</p></div>
			<div class="modal-actions"><button class="button button-primary" type="submit" ${returnable.length ? '' : 'disabled'}>تسجيل المرتجع ${icon('corner-down-left')}</button></div>
			${returnable.length ? '' : '<p class="form-hint">لا توجد أذون صرف بكمية متبقية يمكن إرجاعها.</p>'}
		</form></section>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">السجل</p><h3>كل مرتجعات الإنتاج</h3></div><span class="quiet-badge">${formatNumber(state.productionReturns.length, 0)} مرتجع</span></div>
		${state.productionReturns.length ? `<div class="table-scroll"><table><thead><tr><th>رقم إذن الصرف</th><th>كود الصنف</th><th>اسم الصنف</th><th>المخزن</th><th>خط الإنتاج</th><th>الكمية المرتجعة</th><th>التاريخ</th></tr></thead><tbody>${state.productionReturns.map(productionReturnRow).join('')}</tbody></table></div>` : emptyState('corner-down-left', 'لا توجد مرتجعات مسجلة', 'ستظهر هنا المرتجعات المرتبطة بأذون الصرف.')}</section>`;
}

function productionReturnRow(movement) {
	const material = getMaterial(movement.material_id);
	const unit = isCountUnit(material?.unit) ? material.unit : 'kg';
	return `<tr data-select-kind="movement" data-select-id="${escapeHtml(movement.id)}"><td>${escapeHtml(movement.voucher_no || '—')}</td><td>${escapeHtml(materialCode(material))}</td><td>${escapeHtml(material?.name || 'صنف محذوف')}</td><td>${escapeHtml(getWarehouse(movement.warehouse_id)?.name || '—')}</td><td>${escapeHtml(movement.beneficiary || '—')}</td><td class="amount-cell">${material ? displayAmount(Number(movement.quantity_base), unit) : '—'}</td><td>${formatDate(movement.happened_at)}</td></tr>`;
}

function returnIssueReference(issue) {
	const voucher = String(issue.voucher_no || '').trim();
	if (!voucher || state.returnableIssues.filter(item => String(item.voucher_no || '').trim() === voucher).length === 1) return voucher || issue.issue_id;
	const material = getMaterial(issue.material_id);
	return `${voucher} · ${materialCode(material)} · ${material?.name || ''} · ${issue.issue_id.slice(0, 6)}`;
}

function findReturnableIssue(reference) {
	const value = String(reference || '').trim();
	if (!value) return null;
	const byReference = state.returnableIssues.filter(issue => returnIssueReference(issue).toLocaleLowerCase() === value.toLocaleLowerCase());
	if (byReference.length === 1) return byReference[0];
	const byId = state.returnableIssues.filter(issue => issue.issue_id === value);
	return byId.length === 1 ? byId[0] : null;
}

function renderSuppliersPage() {
	return `<div class="section-intro"><div><p class="eyebrow">الشراء</p><h2>الموردين</h2><p class="muted">سجل الموردين هنا ثم اربطهم بالأصناف وحركات الاستلام.</p></div><button class="button button-primary" data-action="add-supplier">${icon('plus')} إضافة مورد</button></div>
		<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">الدليل</p><h3>الموردون المسجلون</h3></div><span class="quiet-badge">${formatNumber(state.suppliers.length, 0)} مورد</span></div>
			${state.suppliers.length ? `<div class="table-scroll"><table><thead><tr><th>المورد</th><th>الأصناف التي يوردها</th><th>ملاحظات</th><th></th></tr></thead><tbody>${state.suppliers.map(supplier => {
				return `<tr data-select-kind="supplier" data-select-id="${supplier.id}"><td><b class="table-primary">${escapeHtml(supplier.name)}</b></td><td>${escapeHtml(supplierMaterialLabels(supplier))}</td><td>${escapeHtml(supplier.notes || '—')}</td><td><button class="icon-button row-action" data-action="edit-supplier" data-supplier="${supplier.id}" title="تعديل">${icon('pencil')}</button><button class="row-delete-button" data-action="delete-supplier" data-supplier="${supplier.id}" title="حذف">${icon('trash-2')}<span>حذف</span></button></td></tr>`;
			}).join('')}</tbody></table></div>` : emptyState('handshake', 'لا يوجد موردون بعد', 'أضف موردًا لربطه بالأصناف عند الإضافة أو الاستلام.')}
		</section>`;
}

function movementRow(movement) {
	const material = getMaterial(movement.material_id);
	if (!material) return '';
	const incoming = Number(movement.quantity_base) >= 0;
	const amount = `${incoming ? '+' : '−'} ${displayAmount(Math.abs(Number(movement.quantity_base)), material.unit)}`;
	const extra = movement.voucher_no ? ` · إذن ${movement.voucher_no}` : movement.beneficiary ? ` · ${movement.beneficiary}` : '';
	return `<div class="movement-row"><span class="movement-symbol ${incoming ? 'incoming' : 'outgoing'}">${icon(incoming ? 'arrow-down-left' : 'arrow-up-left', 16)}</span><span class="movement-copy"><b>${escapeHtml(materialCode(material))} · ${escapeHtml(material.name)}</b><small>${MOVEMENT_LABELS[movement.movement_type] || 'حركة'}${extra} · ${formatDate(movement.happened_at)}</small></span><b class="movement-amount ${incoming ? 'positive' : 'negative'}">${amount}</b>${movement.movement_type === 'production_issue' ? '' : `<button class="icon-button row-action" data-edit-movement="${movement.id}" title="تعديل تاريخ الحركة">${icon('calendar-cog')}</button>`}</div>`;
}

async function openReports() {
	await loadReportSnapshot();
	state.page = 'reports';
	state.warehouseId = null;
	renderApp();
}

function bindTableSelection() {
	const tables = [...app.querySelectorAll('.table-panel table, .low-panel table')];
	tables.forEach((table, index) => {
		const rows = [...table.querySelectorAll('tbody tr[data-select-kind][data-select-id]')];
		if (!rows.length) return;
		const scope = `${state.page}:${index}`;
		const validIds = new Set(rows.map(row => row.dataset.selectId));
		const selected = new Set((state.tableSelections[scope] || []).filter(id => validIds.has(id)));
		const panel = table.closest('.panel');
		panel?.classList.toggle('selection-active', Boolean(state.tableSelectionModes[scope]));
		table.dataset.selectionScope = scope;

		const headerCell = document.createElement('th');
		headerCell.className = 'table-select-cell';
		headerCell.innerHTML = '<input type="checkbox" data-select-all-checkbox aria-label="تحديد كل الصفوف">';
		table.tHead?.rows[0]?.prepend(headerCell);
		for (const row of rows) {
			const cell = document.createElement('td');
			cell.className = 'table-select-cell';
			cell.innerHTML = `<input type="checkbox" data-row-selection aria-label="تحديد الصف">`;
			row.prepend(cell);
		}

		const toolbar = document.createElement('div');
		toolbar.className = 'table-selection-toolbar';
		toolbar.innerHTML = `<span data-selection-count></span><div><button type="button" class="button button-secondary button-small" data-select-all-table>تحديد الكل</button><button type="button" class="button button-danger-outline button-small" data-delete-selected>حذف المحدد</button><button type="button" class="button button-danger button-small" data-delete-all-table>حذف الكل</button><button type="button" class="button button-secondary button-small" data-close-selection>إنهاء التحديد</button></div>`;
		const scroll = table.closest('.table-scroll');
		if (scroll) scroll.before(toolbar); else table.before(toolbar);
		toolbar.querySelector('[data-select-all-table]').addEventListener('click', () => setTableSelection(table, true));
		toolbar.querySelector('[data-delete-selected]').addEventListener('click', () => showBulkDeleteModal(table, false));
		toolbar.querySelector('[data-delete-all-table]').addEventListener('click', () => showBulkDeleteModal(table, true));
		toolbar.querySelector('[data-close-selection]').addEventListener('click', () => setTableSelectionMode(table, false));
		table.querySelector('[data-select-all-checkbox]')?.addEventListener('change', event => {
			setTableSelectionMode(table, true);
			setTableSelection(table, event.currentTarget.checked);
		});
		table.querySelectorAll('[data-row-selection]').forEach((checkbox, rowIndex) => checkbox.addEventListener('change', event => {
			setTableSelectionMode(table, true);
			const rowId = rows[rowIndex].dataset.selectId;
			const next = new Set(state.tableSelections[scope] || []);
			if (event.currentTarget.checked) next.add(rowId); else next.delete(rowId);
			state.tableSelections[scope] = [...next];
			updateTableSelection(table);
		}));
		const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches || false;
		for (const row of rows) {
			let holdTimer = null;
			let startX = 0;
			let startY = 0;
			const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
			row.addEventListener('click', event => {
				if (coarsePointer || event.target.closest('button, input, select, a, [role="button"]')) return;
				setTableSelectionMode(table, true);
				toggleTableRowSelection(table, row);
			});
			row.addEventListener('pointerdown', event => {
				if ((!coarsePointer && event.pointerType !== 'touch') || event.target.closest('button, input, select, a, [role="button"]')) return;
				startX = event.clientX;
				startY = event.clientY;
				holdTimer = setTimeout(() => {
					setTableSelectionMode(table, true);
					setRowSelected(table, row, true);
				}, 600);
			});
			row.addEventListener('pointermove', event => {
				if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) cancelHold();
			});
			row.addEventListener('pointerup', cancelHold);
			row.addEventListener('pointercancel', cancelHold);
			row.addEventListener('pointerleave', cancelHold);
			row.addEventListener('contextmenu', event => {
				if (!coarsePointer || event.target.closest('button, input, select, a, [role="button"]')) return;
				event.preventDefault();
				setTableSelectionMode(table, true);
				setRowSelected(table, row, true);
			});
		}
		updateTableSelection(table);
	});
}

function setTableSelectionMode(table, active) {
	const scope = table.dataset.selectionScope;
	state.tableSelectionModes[scope] = active;
	if (!active) state.tableSelections[scope] = [];
	table.closest('.panel')?.classList.toggle('selection-active', active);
	updateTableSelection(table);
}

function setRowSelected(table, row, selected) {
	const scope = table.dataset.selectionScope;
	const next = new Set(state.tableSelections[scope] || []);
	if (selected) next.add(row.dataset.selectId); else next.delete(row.dataset.selectId);
	state.tableSelections[scope] = [...next];
	updateTableSelection(table);
}

function toggleTableRowSelection(table, row) {
	const selected = new Set(state.tableSelections[table.dataset.selectionScope] || []);
	setRowSelected(table, row, !selected.has(row.dataset.selectId));
}

function updateTableSelection(table) {
	const scope = table.dataset.selectionScope;
	const selected = new Set(state.tableSelections[scope] || []);
	const rows = [...table.querySelectorAll('tbody tr[data-select-kind][data-select-id]')];
	table.querySelectorAll('[data-row-selection]').forEach((checkbox, index) => {
		checkbox.checked = selected.has(rows[index]?.dataset.selectId);
	});
	const selectAll = table.querySelector('[data-select-all-checkbox]');
	if (selectAll) {
		selectAll.checked = rows.length > 0 && rows.every(row => selected.has(row.dataset.selectId));
		selectAll.indeterminate = selected.size > 0 && !selectAll.checked;
	}
	const toolbar = table.closest('.panel')?.querySelector('.table-selection-toolbar');
	if (!toolbar) return;
	toolbar.querySelector('[data-selection-count]').textContent = `${formatNumber(selected.size, 0)} محدد`;
	toolbar.querySelector('[data-delete-selected]').disabled = selected.size === 0;
}

function setTableSelection(table, selectAll) {
	const scope = table.dataset.selectionScope;
	const rows = [...table.querySelectorAll('tbody tr[data-select-kind][data-select-id]')];
	state.tableSelectionModes[scope] = true;
	table.closest('.panel')?.classList.add('selection-active');
	state.tableSelections[scope] = selectAll ? rows.map(row => row.dataset.selectId) : [];
	updateTableSelection(table);
}

function showBulkDeleteModal(table, deleteAll) {
	const rows = [...table.querySelectorAll('tbody tr[data-select-kind][data-select-id]')];
	const selected = new Set(state.tableSelections[table.dataset.selectionScope] || []);
	const targets = deleteAll ? rows : rows.filter(row => selected.has(row.dataset.selectId));
	if (!targets.length) return toast('لا توجد صفوف محددة للحذف', 'error');
	const kinds = [...new Set(targets.map(row => row.dataset.selectKind))];
	if (kinds.length !== 1) return toast('لا يمكن حذف أنواع سجلات مختلفة في عملية واحدة', 'error');
	const kind = kinds[0];
	const ids = targets.map(row => row.dataset.selectId);
	const impact = kind === 'material'
		? 'سيؤدي ذلك إلى حذف حركات هذه الأصناف وأرصدتها نهائيًا.'
		: kind === 'movement'
			? 'سيؤدي ذلك إلى تعديل الأرصدة. حذف إذن صرف سيحذف المرتجعات المرتبطة به.'
			: 'سيتم حذف المورد وفك ارتباطه بالأصناف والحركات.';
	state.pendingBulkDelete = { scope: table.dataset.selectionScope, kind, ids };
	showModal(deleteAll ? 'تأكيد حذف كل الصفوف الظاهرة' : 'تأكيد حذف الصفوف المحددة', `${deleteAll ? 'سيتم حذف كل' : 'سيتم حذف'} ${formatNumber(ids.length, 0)} سجل من هذا الجدول فقط. ${impact}`, `<form id="modal-form" class="form-stack" data-form="bulk-delete"><div class="delete-warning">${icon('triangle-alert')}<span>الحذف نهائي ولا يمكن التراجع عنه.</span></div><div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-danger" type="submit">تأكيد الحذف ${icon('trash-2')}</button></div></form>`);
}

async function deleteBulkRecords() {
	const pending = state.pendingBulkDelete;
	if (!pending?.ids.length) throw new Error('لا توجد سجلات محددة للحذف');
	const table = ({ material: 'materials', supplier: 'suppliers', movement: 'stock_movements' })[pending.kind];
	if (!table) throw new Error('نوع السجل غير مدعوم للحذف الجماعي');
	const filteredMaterialId = state.page === 'material-history' ? state.filteredMaterialId : null;
	const { error } = await state.client.from(table).delete().in('id', pending.ids);
	if (error) throw error;
	state.tableSelections[pending.scope] = [];
	state.tableSelectionModes[pending.scope] = false;
	state.pendingBulkDelete = null;
	closeModal();
	await loadData();
	if (filteredMaterialId && getMaterial(filteredMaterialId)) await openMaterialFilter(filteredMaterialId);
	toast(`تم حذف ${formatNumber(pending.ids.length, 0)} سجل`);
}

function updateMobileNavArrows() {
	const nav = app.querySelector('.side-nav');
	if (!nav) return;
	const bounds = nav.getBoundingClientRect();
	const links = [...nav.querySelectorAll('.nav-link')];
	app.querySelectorAll('[data-nav-scroll]').forEach(button => {
		const direction = Number(button.dataset.navScroll);
		button.disabled = direction > 0
			? !links.some(link => link.getBoundingClientRect().right < bounds.left - 1)
			: !links.some(link => link.getBoundingClientRect().left > bounds.right + 1);
	});
}

function scrollMobileNav(direction) {
	const nav = app.querySelector('.side-nav');
	if (!nav) return;
	const bounds = nav.getBoundingClientRect();
	const links = [...nav.querySelectorAll('.nav-link')];
	const target = direction > 0
		? links.find(link => link.getBoundingClientRect().right < bounds.left - 1)
		: [...links].reverse().find(link => link.getBoundingClientRect().left > bounds.right + 1);
	target?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

function bindAppEvents() {
	bindTableSelection();
	const mobileNav = app.querySelector('.side-nav');
	mobileNav?.addEventListener('scroll', updateMobileNavArrows, { passive: true });
	app.querySelectorAll('[data-nav-scroll]').forEach(button => button.addEventListener('click', () => scrollMobileNav(Number(button.dataset.navScroll))));
	requestAnimationFrame(updateMobileNavArrows);
	app.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', async () => {
		if (button.dataset.page === 'reports') {
			try { await withBusy(button, openReports); }
			catch (error) { toast(error.message || 'تعذر فتح التقارير', 'error'); }
			return;
		}
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
	searchInput?.addEventListener('input', () => { void renderSearchResults(searchInput.value); });
	searchInput?.addEventListener('focus', () => { if (searchInput.value.trim()) void renderSearchResults(searchInput.value); });
	searchInput?.addEventListener('keydown', async event => {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (state.searchRenderedTerm !== searchInput.value.trim()) await renderSearchResults(searchInput.value);
		const firstResult = app.querySelector('#search-results .search-result');
		if (firstResult) {
			firstResult.click();
		}
	});
	app.querySelector('#issue-form')?.addEventListener('submit', event => submitModal(event));
	app.querySelector('#issue-form')?.addEventListener('input', event => {
		captureIssueDraft();
		if (event.target.matches('[data-issue-material]')) updateIssueLineUnit(event.target.closest('[data-issue-line]'));
	});
	app.querySelector('#issue-form')?.addEventListener('change', () => captureIssueDraft());
	app.querySelector('#return-form')?.addEventListener('submit', event => submitModal(event));
	app.querySelector('#return-issue')?.addEventListener('input', updateReturnFormDetails);
	app.querySelector('#report-date')?.addEventListener('change', async event => {
		state.reportDate = event.target.value || today();
		try {
			await loadReportSnapshot();
			renderApp();
		} catch (error) {
			toast(error.message || 'تعذر تحديث التقرير', 'error');
		}
	});
}

function handleAction(button) {
	const action = button.dataset.action;
	if (action === 'toggle-warehouse-state') {
		const warehouse = getWarehouse(button.dataset.warehouse);
		if (!warehouse) return toast('تعذر العثور على المخزن', 'error');
		void withBusy(button, async () => {
			const nextState = warehouse.is_open === false;
			const { error } = await state.client.from('warehouses').update({ is_open: nextState }).eq('id', warehouse.id);
			if (error) throw error;
			await loadData();
			toast(nextState ? 'تم فتح المخزن وأصبح متاحًا للصرف' : 'تم إغلاق المخزن وإيقاف الصرف منه');
		});
	}
	if (action === 'back-home') { state.page = 'home'; state.warehouseId = null; renderApp(); }
	if (action === 'clear-material-filter') {
		state.filterSequence++;
		state.page = state.filterReturnPage || 'home';
		state.warehouseId = state.filterReturnWarehouseId;
		state.filteredMaterialId = null;
		state.filteredMaterialIds = [];
		state.filteredMovements = [];
		state.materialFilterLoading = false;
		state.focusMovementId = null;
		renderApp();
	}
	if (action === 'toggle-issue-form') { if (state.issueFormExpanded) captureIssueDraft(); state.issueFormExpanded = !state.issueFormExpanded; renderApp(); }
	if (action === 'toggle-issue-history') { state.issueHistoryExpanded = !state.issueHistoryExpanded; renderApp(); }
	if (action === 'add-issue-line') { captureIssueDraft(); state.issueDraftLines.push(newIssueDraftLine()); renderApp(); }
	if (action === 'remove-issue-line') { captureIssueDraft(); state.issueDraftLines = state.issueDraftLines.filter(line => line.key !== button.dataset.issueLine); if (!state.issueDraftLines.length) state.issueDraftLines = [newIssueDraftLine()]; renderApp(); }
	if (action === 'copy-issue-draft') {
		try { if (copyIssueDraft()) renderApp(); }
		catch (error) { toast(error.message || 'تعذر نسخ مسودة الإذن', 'error'); }
	}
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
	if (action === 'add-supplier') showSupplierModal();
	if (action === 'edit-supplier') showSupplierModal(button.dataset.supplier);
	if (action === 'delete-supplier') showDeleteModal('supplier', button.dataset.supplier);
	if (action === 'logout') state.client.auth.signOut();
	if (action === 'signup') showSignup();
	if (action === 'export-report') exportReport();
}

async function searchMovementMatches(term) {
	const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
	const fields = ['voucher_no', 'beneficiary', 'supplier', 'notes'];
	const results = await Promise.all(fields.map(field => state.client.from('stock_movements').select('*')
		.ilike(field, pattern).order('happened_at', { ascending: false }).limit(8)));
	const failed = results.find(result => result.error);
	if (failed) throw failed.error;
	const records = new Map();
	for (const result of results) for (const movement of result.data || []) records.set(movement.id, movement);
	return [...records.values()].sort((a, b) => new Date(b.happened_at) - new Date(a.happened_at)).slice(0, 16);
}

async function renderSearchResults(query) {
	const resultsElement = document.querySelector('#search-results');
	if (!resultsElement) return;
	const term = query.trim().toLocaleLowerCase();
	if (!term) { state.searchRenderedTerm = ''; resultsElement.hidden = true; resultsElement.innerHTML = ''; return; }
	const sequence = ++state.searchSequence;
	const warehouses = state.warehouses.filter(warehouse => warehouse.name.toLocaleLowerCase().includes(term)).slice(0, 4);
	const materials = state.materials.filter(material => material.name.toLocaleLowerCase().includes(term) || materialCode(material).toLocaleLowerCase().includes(term)).slice(0, 6);
	const suppliers = state.suppliers.filter(supplier => supplier.name.toLocaleLowerCase().includes(term) || (supplier.phone || '').includes(term)).slice(0, 4);
	let movements = [];
	if (state.client && state.session) {
		try { movements = await searchMovementMatches(term); }
		catch { movements = []; }
	}
	if (sequence !== state.searchSequence || app.querySelector('#global-search')?.value.trim().toLocaleLowerCase() !== term) return;
	state.searchRenderedTerm = query.trim();
	const hasResults = warehouses.length || materials.length || suppliers.length || movements.some(movement => getMaterial(movement.material_id));
	resultsElement.innerHTML = `<div class="popover-heading">${icon('search', 15)} نتائج البحث</div>${hasResults ? `${warehouses.map(warehouse => `<button class="search-result" data-search-warehouse="${warehouse.id}"><span class="result-icon">${icon(warehouse.kind === 'empties' ? 'package-open' : 'warehouse', 16)}</span><span><b>${escapeHtml(warehouse.name)}</b><small>مخزن ${warehouseKindLabel(warehouse.kind)}</small></span>${icon('arrow-up-left', 15)}</button>`).join('')}${materials.map(material => `<button class="search-result" data-filter-material="${material.id}"><span class="result-icon result-material">${icon('package', 16)}</span><span><b>${escapeHtml(material.name)}</b><small>${escapeHtml(materialCode(material))} · ${escapeHtml(getWarehouse(material.warehouse_id)?.name || 'مخزن')}</small></span><span class="result-amount">${displayAmount(itemBalance(material), material.unit)}</span></button>`).join('')}${suppliers.map(supplier => `<button class="search-result" data-search-page="suppliers"><span class="result-icon">${icon('handshake', 16)}</span><span><b>${escapeHtml(supplier.name)}</b><small>مورد${supplier.phone ? ` · ${escapeHtml(supplier.phone)}` : ''}</small></span>${icon('arrow-up-left', 15)}</button>`).join('')}${movements.filter(movement => getMaterial(movement.material_id)).map(movement => {
		const material = getMaterial(movement.material_id);
		const title = movement.voucher_no ? `مستند ${movement.voucher_no}` : MOVEMENT_LABELS[movement.movement_type] || 'حركة';
		return `<button class="search-result" data-filter-material="${material.id}" data-focus-movement="${movement.id}"><span class="result-icon">${icon(movement.movement_type === 'production_issue' ? 'factory' : 'arrow-left-right', 16)}</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(material.name)} · ${escapeHtml(movement.beneficiary || movement.supplier || movement.notes || MOVEMENT_LABELS[movement.movement_type] || 'حركة')} · ${formatDate(movement.happened_at)}</small></span>${icon('arrow-up-left', 15)}</button>`;
	}).join('')}` : `<div class="popover-empty">لا توجد بيانات مطابقة للبحث.</div>`}`;
	resultsElement.hidden = false;
	resultsElement.querySelectorAll('[data-search-warehouse]').forEach(result => result.addEventListener('click', () => {
		state.page = 'warehouse'; state.warehouseId = result.dataset.searchWarehouse; renderApp();
	}));
	resultsElement.querySelectorAll('[data-filter-material]').forEach(result => result.addEventListener('click', () => {
		void openMaterialFilter(result.dataset.filterMaterial, result.dataset.focusMovement || null);
	}));
	resultsElement.querySelectorAll('[data-search-page]').forEach(result => result.addEventListener('click', () => {
		state.page = result.dataset.searchPage; state.warehouseId = null; renderApp();
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
	menu.querySelector('[data-notification-reports]')?.addEventListener('click', async () => {
		try { await openReports(); }
		catch (error) { toast(error.message || 'تعذر فتح التقارير', 'error'); }
	});
}

function showModal(title, description, content) {
	document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-dismiss><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">${title}</h2><p>${description}</p></div><button class="icon-button" data-dismiss aria-label="إغلاق">${icon('x')}</button></header>${content}</section></div>`;
	document.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) closeModal(); });
	bindModal(); renderIcons();
}
function closeModal() { state.pendingBulkDelete = null; document.querySelector('#modal-root').innerHTML = ''; }
function bindModal() {
	document.querySelectorAll('#modal-root .modal [data-dismiss]').forEach(button => button.addEventListener('click', closeModal));
	document.querySelector('#warehouse-kind')?.addEventListener('change', event => {
		const unit = document.querySelector('#warehouse-unit');
		if (unit) unit.innerHTML = unitOptions(event.target.value === 'empties');
	});
	document.querySelector('#movement-type')?.addEventListener('change', updateMovementForm);
	document.querySelector('#movement-material')?.addEventListener('change', updateMovementUnit);
	document.querySelector('#modal-form')?.addEventListener('submit', event => submitModal(event));
	document.querySelector('#add-supplier-material')?.addEventListener('click', addSupplierMaterialToDraft);
	document.querySelector('#supplier-material-list')?.addEventListener('click', event => {
		const removeButton = event.target.closest('[data-remove-supplier-material]');
		if (!removeButton) return;
		state.supplierDraftMaterialIds = state.supplierDraftMaterialIds.filter(id => id !== removeButton.dataset.removeSupplierMaterial);
		renderSupplierMaterialDraft();
	});
	renderSupplierMaterialDraft();
}

function unitOptions(empties, selected = '') {
	const units = empties
		? (isCountUnit(selected) ? [[selected, UNIT_LABELS[selected]]] : [['bag', 'شكارة'], ['pack', 'عبوة']])
		: [['kg', 'كيلو'], ['g', 'جرام'], ['ton', 'طن']];
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
		<div class="form-grid"><label>كود الصنف<input name="code" maxlength="40" placeholder="مثال: RAW-014" required></label><label>اسم الصنف<input name="name" maxlength="100" placeholder="اكتب اسم الصنف" required></label></div>
		<div class="form-grid"><label>وحدة القياس<select name="unit">${unitOptions(empties)}
		</select></label><label>الحد الأدنى ${empties ? '(شكارة)' : ''}<input name="minimum" type="number" min="0" step="any" value="0"></label></div>
		<div class="form-grid"><label>الرصيد الافتتاحي<input name="opening" type="number" min="0" step="any" value="0"></label><label>تاريخ الرصيد<input name="date" type="date" value="${today()}" max="${today()}" required></label></div>
		<label>المورد${supplierOptions()}</label>
		<p class="form-hint">اكتب اسم المورد أو اختر اسمًا مسجلًا. كود الصنف فريد على مستوى الحساب.</p>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">حفظ الصنف ${icon('check')}</button></div>
	</form>`);
}

function showEditMaterialModal(materialId) {
	const material = getMaterial(materialId);
	if (!material) return;
	const divisor = WEIGHT_UNITS[material.unit] || 1;
	showModal('تعديل بيانات الصنف', 'يؤثر تعديل الاسم على الحركات السابقة المرتبطة به، ولا يغيّر سجل الأرصدة.', `<form id="modal-form" class="form-stack" data-form="edit-material" data-material="${material.id}">
		<div class="form-grid"><label>كود الصنف<input name="code" maxlength="40" value="${escapeHtml(material.code || '')}" required></label><label>اسم الصنف<input name="name" maxlength="100" value="${escapeHtml(material.name)}" required></label></div>
		<label>المورد${supplierOptions(material.supplier_id || material.supplier || '')}</label>
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

function showSupplierModal(supplierId = '') {
	const supplier = supplierId ? getSupplier(supplierId) : null;
	state.supplierDraftMaterialIds = supplier ? state.materials.filter(material => material.supplier_id === supplier.id).map(material => material.id) : [];
	const materialOptions = state.materials.filter(material => !state.supplierDraftMaterialIds.includes(material.id))
		.map(material => `<option value="${material.id}">${escapeHtml(materialCode(material))} · ${escapeHtml(material.name)} · ${UNIT_LABELS[material.unit]}</option>`).join('');
	showModal(supplier ? 'تعديل المورد' : 'إضافة مورد', 'اربط بالمورد الأصناف التي يوردها. يمكن للمورد توفير أكثر من صنف.', `<form id="modal-form" class="form-stack" data-form="${supplier ? 'edit-supplier' : 'supplier'}" ${supplier ? `data-supplier="${supplier.id}"` : ''}>
		<label>اسم المورد<input name="name" maxlength="120" value="${escapeHtml(supplier?.name || '')}" required></label>
		<label for="supplier-material-choice">إضافة صنف</label><div class="supplier-material-picker"><select id="supplier-material-choice"><option value="">اختر صنفًا</option>${materialOptions}</select><button class="button button-secondary" type="button" id="add-supplier-material">${icon('plus')} إضافة الصنف</button></div>
		<div id="supplier-material-list" class="supplier-material-list"></div>
		<label>ملاحظات<input name="notes" maxlength="200" value="${escapeHtml(supplier?.notes || '')}" placeholder="اختياري"></label>
		<div class="modal-actions"><button type="button" class="button button-secondary" data-dismiss>إلغاء</button><button class="button button-primary" type="submit">${supplier ? 'حفظ التعديل' : 'حفظ المورد'} ${icon('check')}</button></div>
	</form>`);
}

function addSupplierMaterialToDraft() {
	const select = document.querySelector('#supplier-material-choice');
	const materialId = select?.value;
	if (!materialId || state.supplierDraftMaterialIds.includes(materialId)) return;
	state.supplierDraftMaterialIds.push(materialId);
	renderSupplierMaterialDraft();
}

function renderSupplierMaterialDraft() {
	const list = document.querySelector('#supplier-material-list');
	const select = document.querySelector('#supplier-material-choice');
	if (!list || !select) return;
	const selected = new Set(state.supplierDraftMaterialIds);
	list.innerHTML = state.supplierDraftMaterialIds.map(materialId => {
		const material = getMaterial(materialId);
		if (!material) return '';
		return `<div class="supplier-material-chip"><span><b>${escapeHtml(materialCode(material))}</b> · ${escapeHtml(material.name)} <small>${UNIT_LABELS[material.unit]}</small><input type="hidden" name="material_ids" value="${material.id}"></span><button type="button" class="icon-button" data-remove-supplier-material="${material.id}" aria-label="إزالة ${escapeHtml(material.name)}">${icon('x', 15)}</button></div>`;
	}).join('') || '<p class="form-hint">لم تُضف أصنافًا لهذا المورد بعد.</p>';
	const options = state.materials.filter(material => !selected.has(material.id))
		.map(material => `<option value="${material.id}">${escapeHtml(materialCode(material))} · ${escapeHtml(material.name)} · ${UNIT_LABELS[material.unit]}</option>`).join('');
	select.innerHTML = `<option value="">اختر صنفًا</option>${options}`;
	select.value = '';
}

function showDeleteModal(kind, id) {
	const record = kind === 'warehouse' ? getWarehouse(id) : kind === 'supplier' ? getSupplier(id) : getMaterial(id);
	if (!record) return;
	const title = kind === 'warehouse' ? 'حذف المخزن' : kind === 'supplier' ? 'حذف المورد' : 'حذف الصنف';
	const warning = kind === 'warehouse'
		? 'سيؤدي ذلك إلى حذف المخزن وأصنافه وجميع حركاتها نهائيًا، ولن تظهر هذه البيانات في التقارير.'
		: kind === 'supplier'
			? 'سيُحذف المورد من الدليل. الأصناف والحركات السابقة تبقى، ويُفك الربط فقط.'
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
	const selectedMaterial = getMaterial(materialId);
	const materialOptions = materials.map(material => `<option value="${escapeHtml(`${material.name} · ${materialCode(material)}`)}"></option>`).join('');
	const destinations = state.warehouses.filter(item => item.kind === warehouse.kind && item.id !== warehouse.id);
	showModal('تسجيل حركة مخزون', `مخزن ${escapeHtml(warehouse.name)} · سيتم حفظ الحركة بتاريخها.`, `<form id="modal-form" class="form-stack" data-form="movement" data-warehouse="${warehouse.id}">
		<div class="form-grid"><label>نوع الحركة<select id="movement-type" name="type"><option value="inbound">إضافة كمية</option><option value="adjustment">تسوية جرد</option><option value="transfer">تحويل لمخزن آخر</option></select></label><label>الصنف<input id="movement-material" name="material" type="text" list="material-list" value="${escapeHtml(selectedMaterial ? `${selectedMaterial.name} · ${materialCode(selectedMaterial)}` : '')}" required placeholder="اكتب اسم الصنف أو كوده" autocomplete="off"><datalist id="material-list">${materialOptions}</datalist></label></div>
		<div class="form-grid"><label id="quantity-label">الكمية<input name="quantity" type="number" min="0.000001" step="any" required></label><label>وحدة الحركة<select id="movement-unit" name="unit">${unitOptions(warehouse.kind === 'empties', getMaterial(materialId)?.unit)}</select></label></div>
		<label>تاريخ الحركة<input name="date" type="date" value="${today()}" max="${today()}" required></label>
		<label id="supplier-field">المورد${supplierOptions(getMaterial(materialId)?.supplier_id || getMaterial(materialId)?.supplier || '')}</label>
		<label id="inbound-voucher-field" class="hidden">رقم فاتورة أو إذن الاستلام<input name="voucher" maxlength="40" placeholder="اختياري"></label>
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
	document.querySelector('#inbound-voucher-field')?.classList.toggle('hidden', type !== 'inbound');
	const label = document.querySelector('#quantity-label');
	if (label) label.firstChild.textContent = type === 'adjustment' ? 'الرصيد الفعلي بعد الجرد' : type === 'transfer' ? 'كمية التحويل' : 'الكمية';
}

function updateMovementUnit() {
	const form = document.querySelector('#modal-form[data-form="movement"]');
	const material = findWarehouseMaterialByInput(document.querySelector('#movement-material')?.value, form?.dataset.warehouse);
	const warehouse = material && getWarehouse(material.warehouse_id);
	const unit = document.querySelector('#movement-unit');
	if (material && warehouse && unit) unit.innerHTML = unitOptions(warehouse.kind === 'empties', material.unit);
}

function showSignup() {
	showModal('إنشاء حساب للتجربة', 'كل حساب له مخازنه وأرصدته الخاصة، لا يرى بيانات حساب آخر. مناسب لعرض الفكرة على أكثر من شخص.', `<form id="modal-form" class="form-stack" data-form="signup">
		<label>البريد الإلكتروني<input name="email" type="email" required autocomplete="email"></label><label>كلمة المرور<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
		<p class="form-hint">بياناتك تُحفظ في قاعدة النظام فور كل حركة. للدخول مباشرة بعد التسجيل، أوقف Confirm email من Authentication في Supabase.</p>
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
		if (type === 'bulk-delete') await deleteBulkRecords();
		if (type === 'movement') await createMovement(values, form.dataset.warehouse);
		if (type === 'production-issue') await createProductionIssue(values);
		if (type === 'production-return') await createProductionReturn(values);
		if (type === 'supplier') await createSupplier(values);
		if (type === 'edit-supplier') await updateSupplier(values, form.dataset.supplier);
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

function supplierFields(supplierId) {
	const value = String(supplierId || '').trim();
	const supplier = getSupplier(value) || state.suppliers.find(item => item.name.trim().toLocaleLowerCase() === value.toLocaleLowerCase());
	return { supplier_id: supplier?.id || null, supplier: supplier?.name || value || null };
}

async function createMaterial(values, warehouseId) {
	const name = values.get('name').trim();
	const code = normalizeCode(values.get('code'));
	if (!code) throw new Error('أدخل كود الصنف');
	if (codeTaken(code, null, warehouseId)) throw new Error('كود الصنف مستخدم بالفعل في هذا المخزن');
	const unit = values.get('unit');
	const minimum = toBase(values.get('minimum') || 0, unit);
	const linked = supplierFields(values.get('supplier'));
	const opening = Number(values.get('opening') || 0);
	const { error } = await state.client.rpc('create_material_with_opening', {
		p_warehouse_id: warehouseId, p_name: name, p_code: code, p_unit: unit,
		p_supplier_id: linked.supplier_id, p_supplier: linked.supplier,
		p_minimum_base: minimum, p_opening_base: toBase(opening, unit),
		p_happened_at: dateInputTimestamp(values.get('date'))
	});
	if (error) throw error;
	closeModal(); await loadData();
	toast(opening > 0 ? 'تم حفظ الصنف ورصيده الافتتاحي' : 'تم حفظ الصنف');
}

async function updateMaterial(values, materialId) {
	const material = getMaterial(materialId);
	if (!material) throw new Error('تعذر العثور على الصنف');
	const name = values.get('name').trim();
	const code = normalizeCode(values.get('code'));
	if (!code) throw new Error('أدخل كود الصنف');
	if (codeTaken(code, materialId, material.warehouse_id)) throw new Error('كود الصنف مستخدم بالفعل في هذا المخزن');
	const linked = supplierFields(values.get('supplier'));
	const { error } = await state.client.rpc('update_material_identity', {
		p_material_id: materialId, p_name: name, p_code: code,
		p_supplier_id: linked.supplier_id, p_supplier: linked.supplier,
		p_minimum_base: toBase(values.get('minimum'), material.unit)
	});
	if (error) throw error;
	closeModal(); await loadData();
	toast('تم تحديث بيانات الصنف في كل المخازن المرتبطة بكوده');
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
	const table = ({ warehouse: 'warehouses', material: 'materials', supplier: 'suppliers' })[kind];
	if (!table) throw new Error('نوع السجل غير معروف');
	const { error } = await state.client.from(table).delete().eq('id', id);
	if (error) throw error;
	if (kind === 'warehouse' && state.warehouseId === id) state.warehouseId = null;
	closeModal(); await loadData();
	toast(kind === 'warehouse' ? 'تم حذف المخزن وسجلاته التابعة' : kind === 'supplier' ? 'تم حذف المورد مع الاحتفاظ بسجلات الحركات' : 'تم حذف الصنف وحركاته');
}

async function createSupplier(values) {
	const name = values.get('name').trim();
	if (!name) throw new Error('أدخل اسم المورد');
	if (state.suppliers.some(supplier => supplier.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('يوجد مورد بهذا الاسم بالفعل');
	const materialIds = [...new Set(values.getAll('material_ids'))];
	validateSupplierMaterialLinks(materialIds, null);
	const { data: supplier, error } = await state.client.from('suppliers').insert({
		name, notes: values.get('notes').trim() || null,
		user_id: state.session.user.id
	}).select().single();
	if (error) throw error;
	try { await syncSupplierMaterials(supplier, materialIds); }
	catch (linkError) {
		await state.client.from('suppliers').delete().eq('id', supplier.id);
		throw linkError;
	}
	closeModal(); await loadData(); toast('تم حفظ المورد');
}

async function updateSupplier(values, supplierId) {
	const name = values.get('name').trim();
	if (!name) throw new Error('أدخل اسم المورد');
	if (state.suppliers.some(supplier => supplier.id !== supplierId && supplier.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('يوجد مورد بهذا الاسم بالفعل');
	const supplier = getSupplier(supplierId);
	if (!supplier) throw new Error('تعذر العثور على المورد');
	const materialIds = [...new Set(values.getAll('material_ids'))];
	validateSupplierMaterialLinks(materialIds, supplierId);
	const { error } = await state.client.from('suppliers').update({
		name, notes: values.get('notes').trim() || null
	}).eq('id', supplierId);
	if (error) throw error;
	await syncSupplierMaterials({ ...supplier, name }, materialIds);
	closeModal(); await loadData(); toast('تم تحديث بيانات المورد');
}

function validateSupplierMaterialLinks(materialIds, supplierId) {
	const knownIds = new Set(state.materials.map(material => material.id));
	if (materialIds.some(id => !knownIds.has(id))) throw new Error('أحد الأصناف المحددة لم يعد موجودًا');
	const conflict = state.materials.find(material => materialIds.includes(material.id)
		&& material.supplier_id && material.supplier_id !== supplierId);
	if (conflict) throw new Error(`الصنف «${conflict.name}» مرتبط بالفعل بمورد آخر`);
}

async function syncSupplierMaterials(supplier, materialIds) {
	const selectedIds = new Set(materialIds);
	const removedIds = state.materials.filter(material => material.supplier_id === supplier.id && !selectedIds.has(material.id)).map(material => material.id);
	if (removedIds.length) {
		const { error } = await state.client.from('materials').update({ supplier_id: null, supplier: null })
			.in('id', removedIds).eq('supplier_id', supplier.id);
		if (error) throw error;
	}
	if (materialIds.length) {
		const { error } = await state.client.from('materials').update({ supplier_id: supplier.id, supplier: supplier.name }).in('id', materialIds);
		if (error) throw error;
	}
}

async function createProductionReturn(values) {
	const issue = findReturnableIssue(values.get('issue_reference'));
	if (!issue) throw new Error('اختر إذن صرف له كمية متبقية');
	const material = getMaterial(issue.material_id);
	if (!material) throw new Error('تعذر العثور على الصنف المرتبط بإذن الصرف');
	const line = values.get('return_line').trim();
	const quantity = Number(values.get('quantity'));
	if (!line) throw new Error('اكتب اسم خط الإنتاج');
	if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('أدخل كمية أكبر من صفر');
	const unit = isCountUnit(material.unit) ? material.unit : 'kg';
	if (isCountUnit(unit) && !Number.isInteger(quantity)) throw new Error(`كمية ${UNIT_LABELS[unit]} يجب أن تكون رقمًا صحيحًا`);
	const quantityBase = toBase(quantity, unit);
	const remaining = Number(issue.quantity_issued) - Number(issue.quantity_returned);
	if (quantityBase > remaining) throw new Error(`الكمية تتجاوز المتبقي من الإذن: ${displayAmount(remaining, material.unit)}`);
	const { error } = await state.client.from('stock_movements').insert({
		user_id: state.session.user.id, warehouse_id: issue.warehouse_id, material_id: issue.material_id,
		movement_type: 'return', quantity_base: quantityBase, return_for: issue.issue_id,
		voucher_no: issue.voucher_no, beneficiary: line, happened_at: dateInputTimestamp(today()),
		notes: 'مرتجع من الإنتاج'
	});
	if (error) throw error;
	await loadData();
	toast('تم تسجيل المرتجع وربطه بإذن الصرف');
}

async function createProductionIssue(values) {
	const voucher = values.get('voucher').trim();
	const beneficiary = values.get('beneficiary').trim();
	if (!voucher || !beneficiary) throw new Error('أدخل رقم الإذن والمستفيد');
	const mixCount = Number(values.get('mix_count'));
	if (!Number.isInteger(mixCount) || mixCount <= 0) throw new Error('أدخل عدد خلطات صحيحًا أكبر من صفر');
	const materialInputs = values.getAll('material');
	const quantities = values.getAll('quantity');
	if (!materialInputs.length || materialInputs.length !== quantities.length) throw new Error('أضف صنفًا واحدًا على الأقل');
	const activeWarehouseIds = new Set(state.warehouses.filter(warehouse => warehouse.is_open !== false).map(warehouse => warehouse.id));
	const lines = materialInputs.map((input, index) => {
		const materials = findMaterialsByInput(input, activeWarehouseIds);
		const material = materials[0];
		const quantity = Number(quantities[index]);
		if (!material) throw new Error(`اختر صنفًا له كود واضح وموجود في مخزن نشط للسطر ${index + 1}`);
		if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`أدخل كمية صحيحة للصنف ${material.name}`);
		const unit = isCountUnit(material.unit) ? material.unit : 'kg';
		if (isCountUnit(unit) && !Number.isInteger(quantity)) throw new Error(`كمية ${UNIT_LABELS[unit]} للصنف ${material.name} يجب أن تكون رقمًا صحيحًا`);
		return { material, materials, quantityBase: toBase(quantity, unit) };
	});
	if (new Set(lines.map(line => normalizeCode(line.material.code).toLowerCase())).size !== lines.length) throw new Error('لا تكرر كود الصنف في الإذن؛ اجمع الكمية في سطر واحد');
	const stockByLine = await Promise.all(lines.map(async line => Promise.all(line.materials.map(async material => ({
		material,
		balance: await balanceAtDate(material.id, today())
	})))));
	const allocations = lines.flatMap((line, index) =>
		allocateStockByLeastBalance(stockByLine[index], line.quantityBase, line.material.name));
	const issueGroupId = crypto.randomUUID();
	const happenedAt = dateInputTimestamp(today());
	const records = allocations.map(({ material, quantityBase }) => ({
		warehouse_id: material.warehouse_id, material_id: material.id, movement_type: 'production_issue',
		quantity_base: -quantityBase, voucher_no: voucher, beneficiary, mix_count: mixCount,
		issue_group_id: issueGroupId, happened_at: happenedAt, user_id: state.session.user.id
	}));
	const { error } = await state.client.from('stock_movements').insert(records);
	if (error) throw error;
	state.issueDraftMeta = { voucher: '', beneficiary: '', mixCount: '' };
	state.issueDraftLines = [newIssueDraftLine()];
	await loadData(); toast(`تم تسجيل الإذن بعدد ${formatNumber(lines.length, 0)} أصناف`);
}

async function createMovement(values, warehouseId) {
	const warehouse = getWarehouse(warehouseId);
	const material = findWarehouseMaterialByInput(values.get('material'), warehouseId);
	if (!material || !warehouse) throw new Error('تعذر العثور على الصنف أو المخزن');
	if (isCountUnit(material.unit) && values.get('unit') !== material.unit) {
		throw new Error(`وحدة الحركة يجب أن تكون ${UNIT_LABELS[material.unit]}`);
	}
	const asOf = values.get('date');
	const date = dateInputTimestamp(asOf);
	const available = await balanceAtDate(material.id, asOf);
	const baseValues = { warehouse_id: warehouseId, material_id: material.id, happened_at: date, notes: values.get('notes')?.trim() || null, user_id: state.session.user.id };
	const type = values.get('type');
	let record;
	if (type === 'adjustment') {
		const actual = toBase(values.get('quantity'), values.get('unit'));
		const difference = actual - available;
		if (Math.abs(difference) < 0.000001) throw new Error('الرصيد الفعلي مطابق لرصيد النظام، لا توجد تسوية');
		if (difference < 0 && actual < 0) throw new Error('الرصيد الفعلي لا يمكن أن يكون سالبًا');
		record = { ...baseValues, quantity_base: difference, movement_type: difference > 0 ? 'adjustment_in' : 'adjustment_out', notes: [values.get('reason').trim(), baseValues.notes].filter(Boolean).join(' · ') };
	} else if (type === 'transfer') {
		const destination = getWarehouse(values.get('destination'));
		const quantity = toBase(values.get('quantity'), values.get('unit'));
		if (!destination || destination.kind !== warehouse.kind) throw new Error('اختر مخزنًا من نفس النوع');
		if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('أدخل كمية تحويل أكبر من صفر');
		if (quantity > available) throw new Error('الكمية أكبر من الرصيد المتاح بتاريخ الحركة');
		const { error } = await state.client.rpc('transfer_material', {
			p_source_warehouse_id: warehouse.id, p_destination_warehouse_id: destination.id,
			p_material_id: material.id, p_destination_code: material.code,
			p_quantity_base: quantity, p_happened_at: date, p_notes: baseValues.notes
		});
		if (error) throw error;
		closeModal(); await loadData(); toast('تم التحويل بين المخزنين'); return;
	} else {
		const quantity = toBase(values.get('quantity'), values.get('unit'));
		if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('أدخل كمية أكبر من صفر');
		const incoming = type === 'inbound';
		if (!incoming && quantity > available) throw new Error('الكمية أكبر من الرصيد المتاح بتاريخ الحركة');
		const linked = type === 'inbound' ? supplierFields(values.get('supplier')) : { supplier_id: null, supplier: null };
		record = { ...baseValues, quantity_base: incoming ? quantity : -quantity, movement_type: type, voucher_no: type === 'inbound' ? values.get('voucher')?.trim() || null : null, ...linked };
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
	const rows = [['الصنف', 'المورد', 'المخزن', 'النوع', 'الرصيد', 'الوحدة', 'الحد الأدنى', 'الحالة']];
	for (const material of state.materials) {
		const balance = itemBalance(material, state.reportDate);
		const low = Number(material.minimum_base) > 0 && balance <= Number(material.minimum_base);
		rows.push([material.name, materialSupplier(material, state.reportDate), getWarehouse(material.warehouse_id)?.name || '', warehouseKindLabel(getWarehouse(material.warehouse_id)?.kind), (balance / (WEIGHT_UNITS[material.unit] || 1)).toString(), UNIT_LABELS[material.unit], (Number(material.minimum_base) / (WEIGHT_UNITS[material.unit] || 1)).toString(), low ? 'منخفض' : 'طبيعي']);
	}
	const csv = '\uFEFF' + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
	const link = document.createElement('a');
	link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
	link.download = `inventory-${state.reportDate}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

start();
