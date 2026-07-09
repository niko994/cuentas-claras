/**
 * Cuentas Claras v7.0.0
 * App de división proporcional de gastos entre dos personas
 * Con sincronización Firebase en tiempo real
 */

// ===================== CATEGORIES =====================

const CATEGORIES = {
  "Comida":          { name: "Comida / Super",        emoji: "🛒", color: "#10b981", rgb: "16,185,129" },
  "Transporte":      { name: "Transporte / Nafta",    emoji: "🚗", color: "#06b6d4", rgb: "6,182,212" },
  "Vivienda":        { name: "Alquiler / Hogar",      emoji: "🏠", color: "#6366f1", rgb: "99,102,241" },
  "Servicios":       { name: "Servicios / Impuestos", emoji: "💡", color: "#f59e0b", rgb: "245,158,11" },
  "Entretenimiento": { name: "Entretenimiento",       emoji: "🎬", color: "#ec4899", rgb: "236,72,153" },
  "Salud":           { name: "Salud / Farmacia",      emoji: "🏥", color: "#ef4444", rgb: "239,68,68" },
  "Compras":         { name: "Compras / Ropa",        emoji: "🛍️", color: "#8b5cf6", rgb: "139,92,246" },
  "Otros":           { name: "Otros / Varios",        emoji: "⚙️",  color: "#64748b", rgb: "100,116,139" }
};

// ===================== STATE =====================

let state = {
  transactions: [],
  people: {
    personA: { name: "Nicolás", salary: 0 },
    personB: { name: "Jessica", salary: 0 }
  },
  settings: { currency: "ARS" }
};

let transactionFilters = {
  search: "", category: "all", payer: "all",
  sortBy: "date", sortOrder: "desc"
};

let currentPage = 1;
const ITEMS_PER_PAGE = 10;

let categoryChartInstance = null;
let trendChartInstance = null;
let payerChartInstance = null;
let currentTrendType = "bar";

// ===================== FIREBASE / SYNC =====================

const HARDCODED_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDTXqvbNT3H2YW8an7K1GZrjVtjxl276kE",
  authDomain: "gastos-e1978.firebaseapp.com",
  projectId: "gastos-e1978",
  storageBucket: "gastos-e1978.firebasestorage.app",
  messagingSenderId: "922197060937",
  appId: "1:922197060937:web:6c97a06849185d3b537e98"
};


let db = null;
let roomId = null;
let useFirebase = false;
let firestoreUnsubscribe = null;

/**
 * Generates or retrieves the room ID from the URL hash.
 * Room ID is shared between both people via the URL.
 */
function getRoomId() {
  let id = window.location.hash.replace("#", "").trim();
  if (!id || id.length < 6) {
    // Generate a new random room ID
    id = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
    window.location.hash = id;
  }
  return id;
}

/**
 * Initialize Firebase with the provided config
 */
function initFirebase(config) {
  try {
    // If app already initialized, use it
    let app;
    if (firebase.apps.length === 0) {
      app = firebase.initializeApp(config);
    } else {
      app = firebase.apps[0];
    }
    db = firebase.firestore(app);
    return true;
  } catch (e) {
    console.error("Firebase init error:", e);
    return false;
  }
}

/**
 * Subscribe to real-time Firestore updates for this room.
 * When data changes remotely, update state and re-render.
 */
function subscribeToRoom() {
  if (!db || !roomId) return;

  if (firestoreUnsubscribe) firestoreUnsubscribe();

  const docRef = db.collection("rooms").doc(roomId);

  firestoreUnsubscribe = docRef.onSnapshot(
    (doc) => {
      if (doc.exists) {
        const data = doc.data();
        if (data.transactions) state.transactions = data.transactions;
        if (data.people) state.people = data.people;
        if (data.settings) state.settings = data.settings;
        // Persist locally too
        localStorage.setItem("cc_state", JSON.stringify(state));
      }
      renderAll();
      setSyncStatus("online");
    },
    (error) => {
      console.error("Firestore listener error:", error);
      setSyncStatus("offline");
    }
  );
}

/**
 * Save state to Firestore (and localStorage as backup)
 */
async function saveState() {
  // Always save locally first
  localStorage.setItem("cc_state", JSON.stringify(state));

  if (!useFirebase || !db || !roomId) return;

  try {
    await db.collection("rooms").doc(roomId).set(state, { merge: true });
  } catch (e) {
    console.error("Error saving to Firestore:", e);
    setSyncStatus("offline");
  }
}

function setSyncStatus(status) {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (!dot || !label) return;

  dot.className = "sync-dot " + status;
  if (status === "online") label.textContent = "Sincronizado";
  else if (status === "offline") label.textContent = "Sin conexión";
  else label.textContent = "Local";
}

// ===================== HELPERS =====================

function formatCurrency(amount) {
  const sym = state.settings?.currency === "USD" ? "US$" : "$";
  return sym + Number(amount).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCurrencyShort(amount) {
  const n = Number(amount);
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + Math.round(n / 1000) + "k";
  return formatCurrency(n);
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return new Date(+y, +m - 1, +d).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" });
}

function generateId() {
  return "tx_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function getPersonName(key) {
  return state.people[key]?.name || (key === "personA" ? "Persona A" : "Persona B");
}

// ===================== CORE CALCULATION =====================

/**
 * THE HEART OF THE APP.
 *
 * Logic:
 *   - Each person's share = their salary / total salaries
 *   - For each expense, the person who paid covers 100% upfront
 *   - At the end of the period, we calculate:
 *       what each should have paid (their %)
 *       vs. what they actually paid
 *   - The difference = who owes who how much (net)
 *
 * Example:
 *   Nicolás earns $800k (57%), Jessica earns $600k (43%)
 *   Total expenses: $100k
 *   Nicolás should pay $57k, Jessica $43k
 *   If Nicolás paid $80k and Jessica $20k:
 *     Nicolás overpaid $23k → Jessica owes Nicolás $23k
 */
function calculateSplit(monthStr) {
  const salaryA = parseFloat(state.people.personA?.salary) || 0;
  const salaryB = parseFloat(state.people.personB?.salary) || 0;
  const totalSalary = salaryA + salaryB;

  const pctA = totalSalary > 0 ? salaryA / totalSalary : 0.5;
  const pctB = totalSalary > 0 ? salaryB / totalSalary : 0.5;

  // Only count real expenses (not settlements) for the split calculation
  const txs = monthStr
    ? state.transactions.filter(t => t.type === "expense" && !t.isSettlement && t.date?.substring(0, 7) === monthStr)
    : state.transactions.filter(t => t.type === "expense" && !t.isSettlement);

  const totalExpenses = txs.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const paidA = txs.filter(t => t.payer === "personA").reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const paidB = txs.filter(t => t.payer === "personB").reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

  const shouldPayA = totalExpenses * pctA;
  const shouldPayB = totalExpenses * pctB;

  // diffA > 0 means A overpaid → B owes A
  // Subtract any settlement transactions: settlements from B to A reduce B's debt
  const settlements = state.transactions.filter(t => t.isSettlement);
  let settledForA = 0, settledForB = 0;
  settlements.forEach(s => {
    if (s.payer === "personB") settledForA += parseFloat(s.amount) || 0; // B paid A → reduces B debt
    else settledForB += parseFloat(s.amount) || 0; // A paid B
  });

  // Net balance after settlements
  const diffA = (paidA - shouldPayA) - settledForB + settledForA;

  const net = Math.abs(diffA);
  let debtor = null, creditor = null;

  if (net > 0.5) { // ignore < $0.50 rounding
    if (diffA > 0) { creditor = "personA"; debtor = "personB"; }
    else            { creditor = "personB"; debtor = "personA"; }
  }

  return { pctA, pctB, totalExpenses, paidA, paidB, shouldPayA, shouldPayB, net, debtor, creditor, diffA };
}

// ===================== RENDER DASHBOARD =====================

function updateNetHero() {
  // Use local time for monthStr to avoid UTC timezone offset bugs
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Calculate split for ALL time (overall pending balance)
  const { pctA, pctB, paidA, paidB, shouldPayA, shouldPayB, net, debtor, creditor, diffA } = calculateSplit(null);

  // Calculate split specifically for the CURRENT month for the footer stats
  const monthlyStats = calculateSplit(monthStr);

  const nameA = getPersonName("personA");
  const nameB = getPersonName("personB");

  // Update avatars and names everywhere
  document.querySelectorAll(".person-a-avatar").forEach(el => { el.textContent = nameA[0]?.toUpperCase() || "A"; });
  document.querySelectorAll(".person-b-avatar").forEach(el => { el.textContent = nameB[0]?.toUpperCase() || "B"; });
  document.querySelectorAll("[id$='name-a'],[id$='name_a']").forEach(el => { if(el.id !== "setting-name-a") el.textContent = nameA; });
  document.querySelectorAll("[id$='name-b'],[id$='name_b']").forEach(el => { if(el.id !== "setting-name-b") el.textContent = nameB; });

  // Hero amount — NET balance is the star (all-time overall balance)
  const heroAmount = document.getElementById("net-hero-amount");
  const heroSubtitle = document.getElementById("net-hero-subtitle");
  const heroStatusBadge = document.getElementById("net-status-badge");
  const heroStatusIcon = document.getElementById("net-status-icon");
  const heroStatusText = document.getElementById("net-status-text");

  if (heroAmount) {
    const formatted = Number(net).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    heroAmount.textContent = formatted;
  }

  const settleBtn = document.getElementById("btn-settle-balance");

  // Person card elements for debtor/creditor coloring
  const cardA = document.querySelector(".person-a-card");
  const cardB = document.querySelector(".person-b-card");

  if (!debtor) {
    // Balanced!
    if (heroStatusBadge) heroStatusBadge.className = "net-status-badge balanced";
    if (heroStatusIcon) heroStatusIcon.setAttribute("data-lucide", "check-circle-2");
    if (heroStatusText) heroStatusText.textContent = "¡Cuentas al día!";
    if (heroSubtitle) heroSubtitle.textContent = "Todo está pareado. ¡Bien! 🎉";
    if (settleBtn) settleBtn.classList.add("hidden");
    // Neutral cards
    if (cardA) cardA.className = "person-split-card person-a-card";
    if (cardB) cardB.className = "person-split-card person-b-card";
  } else {
    const debtorName = getPersonName(debtor);
    const creditorName = getPersonName(creditor);
    if (heroStatusBadge) heroStatusBadge.className = "net-status-badge owes";
    if (heroStatusIcon) heroStatusIcon.setAttribute("data-lucide", "arrow-right-left");
    if (heroStatusText) heroStatusText.textContent = `${debtorName} debe pagar`;
    if (heroSubtitle) heroSubtitle.textContent = `${debtorName} le debe ${formatCurrency(net)} a ${creditorName}`;
    if (settleBtn) settleBtn.classList.remove("hidden");
    // Color the debtor card red and creditor card green
    if (cardA) cardA.className = "person-split-card person-a-card " + (debtor === "personA" ? "is-debtor" : "is-creditor");
    if (cardB) cardB.className = "person-split-card person-b-card " + (debtor === "personB" ? "is-debtor" : "is-creditor");
  }

  // Person A card (all-time overall status)
  const diffAEl = document.getElementById("hero-diff-a");
  if (diffAEl) {
    diffAEl.textContent = formatCurrencyShort(Math.abs(diffA));
    diffAEl.className = "psc-diff " + (diffA > 0.5 ? "overpaid" : diffA < -0.5 ? "underpaid" : "");
  }
  const paidAEl = document.getElementById("hero-paid-a");
  const shouldAEl = document.getElementById("hero-should-a");
  if (paidAEl) paidAEl.textContent = `Pagó ${formatCurrencyShort(paidA)}`;
  if (shouldAEl) shouldAEl.textContent = `Le toca ${formatCurrencyShort(shouldPayA)}`;

  // Person B card (all-time overall status)
  const diffB = paidB - shouldPayB;
  const diffBEl = document.getElementById("hero-diff-b");
  if (diffBEl) {
    diffBEl.textContent = formatCurrencyShort(Math.abs(diffB));
    diffBEl.className = "psc-diff " + (diffB > 0.5 ? "overpaid" : diffB < -0.5 ? "underpaid" : "");
  }
  const paidBEl = document.getElementById("hero-paid-b");
  const shouldBEl = document.getElementById("hero-should-b");
  if (paidBEl) paidBEl.textContent = `Pagó ${formatCurrencyShort(paidB)}`;
  if (shouldBEl) shouldBEl.textContent = `Le toca ${formatCurrencyShort(shouldPayB)}`;

  // Footer stats (specifically for current month)
  const totalEl = document.getElementById("stat-total-expenses");
  if (totalEl) totalEl.textContent = formatCurrencyShort(monthlyStats.totalExpenses);

  const fnA = document.getElementById("footer-name-a");
  const fnB = document.getElementById("footer-name-b");
  if (fnA) fnA.textContent = nameA;
  if (fnB) fnB.textContent = nameB;

  const fpA = document.getElementById("footer-pct-a");
  const fpB = document.getElementById("footer-pct-b");
  // Use floor+remainder to guarantee exactly 100%
  const pctADisplay = Math.floor(pctA * 100);
  const pctBDisplay = 100 - pctADisplay;
  if (fpA) fpA.textContent = pctADisplay + "%";
  if (fpB) fpB.textContent = pctBDisplay + "%";

  const fCount = document.getElementById("footer-tx-count");
  if (fCount) fCount.textContent = state.transactions.filter(t => t.type === "expense" && t.date?.startsWith(monthStr)).length;

  // Update payer filter options
  const fpa = document.getElementById("filter-payer-a");
  const fpb = document.getElementById("filter-payer-b");
  if (fpa) fpa.textContent = nameA;
  if (fpb) fpb.textContent = nameB;

  // Payer modal buttons
  const pbna = document.getElementById("payer-btn-name-a");
  const pbnb = document.getElementById("payer-btn-name-b");
  if (pbna) pbna.textContent = nameA;
  if (pbnb) pbnb.textContent = nameB;

  // Share URL
  const shareInput = document.getElementById("share-url-input");
  if (shareInput) shareInput.value = window.location.href;

  if (typeof lucide !== "undefined") lucide.createIcons();
}

function renderDashboardRecent() {
  const container = document.getElementById("dashboard-recent-transactions");
  if (!container) return;

  const monthStr = new Date().toISOString().substring(0, 7);
  const recent = [...state.transactions]
    .filter(t => t.type === "expense")
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 7);

  if (recent.length === 0) {
    container.innerHTML = `<p class="text-muted text-center py-6">No hay gastos aún. ¡Cargá el primero!</p>`;
    return;
  }

  container.innerHTML = recent.map(t => {
    const cat = CATEGORIES[t.category] || { emoji: "⚙️", name: t.category };
    const payerKey = t.payer || "personA";
    const payerName = getPersonName(payerKey);
    const payerClass = payerKey === "personA" ? "person-a" : "person-b";

    return `
      <div class="transaction-item">
        <div class="trans-item-left">
          <div class="trans-icon-wrapper">${cat.emoji}</div>
          <div class="trans-details">
            <span class="trans-title">${t.description}</span>
            <span class="trans-meta">
              ${cat.name} · ${formatDate(t.date)}
              <span class="trans-payer-badge ${payerClass}">${payerName}</span>
            </span>
          </div>
        </div>
        <div class="trans-amount">- ${formatCurrency(t.amount)}</div>
      </div>
    `;
  }).join("");
}

// ===================== CHARTS =====================

function renderCategoryChart() {
  const canvas = document.getElementById("categoryChart");
  const empty = document.getElementById("category-chart-empty");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const monthStr = new Date().toISOString().substring(0, 7);

  const totals = {};
  state.transactions.forEach(t => {
    if (t.type === "expense" && t.date?.substring(0, 7) === monthStr) {
      totals[t.category] = (totals[t.category] || 0) + parseFloat(t.amount);
    }
  });

  if (categoryChartInstance) { categoryChartInstance.destroy(); categoryChartInstance = null; }

  const total = Object.values(totals).reduce((s, v) => s + v, 0);
  if (total === 0) {
    canvas.style.display = "none";
    if (empty) empty.style.display = "flex";
    return;
  }
  canvas.style.display = "block";
  if (empty) empty.style.display = "none";

  const labels = [], data = [], bg = [], borders = [];
  Object.keys(totals).forEach(key => {
    const cat = CATEGORIES[key] || { name: key, color: "#64748b", emoji: "" };
    labels.push(`${cat.emoji} ${cat.name}`);
    data.push(totals[key]);
    bg.push(cat.color + "cc");
    borders.push(cat.color);
  });

  categoryChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: bg, borderColor: borders, borderWidth: 2, hoverOffset: 6 }] },
    options: {
      cutout: "78%", responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#64748b", font: { family: "Inter", size: 11, weight: "600" }, padding: 14, usePointStyle: true, boxWidth: 8 } },
        tooltip: {
          backgroundColor: "#fff", titleColor: "#0f172a", bodyColor: "#64748b",
          borderColor: "rgba(0,0,0,0.07)", borderWidth: 1, padding: 12, cornerRadius: 12,
          callbacks: { label: c => ` ${formatCurrency(c.raw)} (${((c.raw/total)*100).toFixed(1)}%)` }
        }
      }
    }
  });
}

function renderPayerChart() {
  const canvas = document.getElementById("payerChart");
  const empty = document.getElementById("payer-chart-empty");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  // Use all-time totals so the chart reflects real cumulative data
  const expenses = state.transactions.filter(t => t.type === "expense");

  let paidA = 0, paidB = 0;
  expenses.forEach(t => {
    if (t.payer === "personA") paidA += parseFloat(t.amount) || 0;
    else paidB += parseFloat(t.amount) || 0;
  });

  if (payerChartInstance) { payerChartInstance.destroy(); payerChartInstance = null; }

  if (paidA === 0 && paidB === 0) {
    canvas.style.display = "none";
    if (empty) empty.style.display = "flex";
    return;
  }
  canvas.style.display = "block";
  if (empty) empty.style.display = "none";

  const nameA = getPersonName("personA");
  const nameB = getPersonName("personB");

  // Horizontal bar chart — more readable, different from doughnut category chart
  payerChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: [nameA, nameB],
      datasets: [{
        label: "Total pagado",
        data: [paidA, paidB],
        backgroundColor: ["rgba(99,102,241,0.85)", "rgba(236,72,153,0.85)"],
        borderColor: ["#6366f1", "#ec4899"],
        borderWidth: 0,
        borderRadius: 10,
        borderSkipped: false
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#fff", titleColor: "#0f172a", bodyColor: "#64748b",
          borderColor: "rgba(0,0,0,0.07)", borderWidth: 1, padding: 12, cornerRadius: 12,
          callbacks: {
            label: c => ` ${formatCurrency(c.raw)} (${((c.raw / (paidA + paidB)) * 100).toFixed(1)}%)`
          }
        }
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.04)" },
          ticks: { color: "#64748b", font: { family: "Inter", size: 11 }, callback: v => formatCurrencyShort(v) },
          border: { display: false }
        },
        y: {
          grid: { display: false },
          ticks: { color: "#0f172a", font: { family: "Inter", size: 13, weight: "700" } },
          border: { display: false }
        }
      }
    }
  });
}

function renderTrendChart() {
  const canvas = document.getElementById("trendChart");
  const empty = document.getElementById("trend-chart-empty");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (trendChartInstance) { trendChartInstance.destroy(); trendChartInstance = null; }

  const months = [], labels = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    months.push(d.toISOString().substring(0, 7));
    labels.push(d.toLocaleDateString("es-AR", { month: "short", year: "2-digit" }));
  }

  const nameA = getPersonName("personA");
  const nameB = getPersonName("personB");

  const dataA = months.map(m => state.transactions.filter(t => t.type === "expense" && t.payer === "personA" && t.date?.startsWith(m)).reduce((s, t) => s + parseFloat(t.amount), 0));
  const dataB = months.map(m => state.transactions.filter(t => t.type === "expense" && t.payer === "personB" && t.date?.startsWith(m)).reduce((s, t) => s + parseFloat(t.amount), 0));

  const hasData = [...dataA, ...dataB].some(v => v > 0);
  if (!hasData) {
    canvas.style.display = "none";
    if (empty) empty.style.display = "flex";
    return;
  }
  canvas.style.display = "block";
  if (empty) empty.style.display = "none";

  const type = currentTrendType;
  trendChartInstance = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [
        { label: nameA, data: dataA, backgroundColor: type === "bar" ? "rgba(99,102,241,0.75)" : "transparent", borderColor: "#6366f1", borderWidth: 2, borderRadius: type === "bar" ? 8 : 0, pointBackgroundColor: "#6366f1", tension: 0.4, fill: false },
        { label: nameB, data: dataB, backgroundColor: type === "bar" ? "rgba(236,72,153,0.75)" : "transparent", borderColor: "#ec4899", borderWidth: 2, borderRadius: type === "bar" ? 8 : 0, pointBackgroundColor: "#ec4899", tension: 0.4, fill: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { color: "#64748b", font: { family: "Inter", size: 11, weight: "600" }, usePointStyle: true, boxWidth: 8, padding: 16 } },
        tooltip: { backgroundColor: "#fff", titleColor: "#0f172a", bodyColor: "#64748b", borderColor: "rgba(0,0,0,0.07)", borderWidth: 1, padding: 12, cornerRadius: 12, callbacks: { label: c => ` ${c.dataset.label}: ${formatCurrency(c.raw)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#64748b", font: { family: "Inter", size: 11 } }, border: { display: false } },
        y: { grid: { color: "rgba(0,0,0,0.04)" }, ticks: { color: "#64748b", font: { family: "Inter", size: 11 } }, border: { display: false } }
      }
    }
  });
}

// ===================== TRANSACTIONS TABLE =====================

function renderTransactionsTable() {
  const tbody = document.getElementById("transactions-tbody");
  const countEl = document.getElementById("filtered-count");
  if (!tbody) return;

  // Include both expenses and settlement transactions in the table
  let filtered = state.transactions.filter(t => t.type === "expense" || t.isSettlement);

  if (transactionFilters.search) {
    const q = transactionFilters.search.toLowerCase();
    filtered = filtered.filter(t => t.description?.toLowerCase().includes(q) || t.category?.toLowerCase().includes(q));
  }
  if (transactionFilters.category !== "all") filtered = filtered.filter(t => t.category === transactionFilters.category);
  if (transactionFilters.payer !== "all") filtered = filtered.filter(t => t.payer === transactionFilters.payer);

  filtered.sort((a, b) => {
    let fa, fb;
    if (transactionFilters.sortBy === "date") { fa = a.date; fb = b.date; }
    else if (transactionFilters.sortBy === "desc") { fa = a.description?.toLowerCase(); fb = b.description?.toLowerCase(); }
    else { fa = parseFloat(a.amount); fb = parseFloat(b.amount); }
    if (fa < fb) return transactionFilters.sortOrder === "asc" ? -1 : 1;
    if (fa > fb) return transactionFilters.sortOrder === "asc" ? 1 : -1;
    return 0;
  });

  const totalPages = Math.max(Math.ceil(filtered.length / ITEMS_PER_PAGE), 1);
  if (currentPage > totalPages) currentPage = totalPages;
  const paginated = filtered.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  if (countEl) countEl.textContent = `${filtered.length} gastos`;

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-6">No se encontraron gastos.</td></tr>`;
    updatePagination(1, 1);
    return;
  }

  tbody.innerHTML = paginated.map(t => {
    const cat = t.isSettlement
      ? { emoji: "🤝", name: "Transferencia" }
      : (CATEGORIES[t.category] || { emoji: "⚙️", name: t.category });
    const payerKey = t.payer || "personA";
    const payerName = getPersonName(payerKey);
    const payerClass = payerKey === "personA" ? "person-a" : "person-b";
    const amountDisplay = t.isSettlement
      ? `<span style="color:#22c55e;font-weight:700">↗ ${formatCurrency(t.amount)}</span>`
      : `- ${formatCurrency(t.amount)}`;
    return `
      <tr${t.isSettlement ? ' style="background:rgba(34,197,94,0.04);"' : ''}>
        <td style="white-space:nowrap;color:var(--text-secondary);font-size:0.8rem;">${formatDate(t.date)}</td>
        <td style="font-weight:600;max-width:200px;">${t.description}</td>
        <td><span style="font-size:0.78rem;background:${t.isSettlement ? '#f0fdf4' : '#f1f5f9'};padding:3px 9px;border-radius:999px;color:${t.isSettlement ? '#16a34a' : 'var(--text-secondary)'};font-weight:600;">${cat.emoji} ${cat.name}</span></td>
        <td><span class="trans-payer-badge ${payerClass}">${payerName}</span></td>
        <td style="text-align:right;font-weight:700;white-space:nowrap;">${amountDisplay}</td>
        <td>
          <div class="table-actions-cell">
            ${!t.isSettlement ? `<button class="btn-table-icon btn-edit-tx" data-id="${t.id}"><i data-lucide="edit-3"></i></button>` : ''}
            <button class="btn-table-icon delete btn-delete-tx" data-id="${t.id}"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  if (typeof lucide !== "undefined") lucide.createIcons();
  updatePagination(currentPage, totalPages);

  tbody.querySelectorAll(".btn-edit-tx").forEach(btn =>
    btn.addEventListener("click", e => openModal(e.currentTarget.getAttribute("data-id")))
  );
  tbody.querySelectorAll(".btn-delete-tx").forEach(btn =>
    btn.addEventListener("click", e => {
      const id = e.currentTarget.getAttribute("data-id");
      confirmAction("¿Eliminar gasto?", "Esta acción no se puede deshacer.", () => {
        state.transactions = state.transactions.filter(t => t.id !== id);
        saveState();
        renderAll();
      });
    })
  );
}

function updatePagination(current, total) {
  const prev = document.getElementById("btn-prev-page");
  const next = document.getElementById("btn-next-page");
  const text = document.getElementById("pagination-text");
  if (prev) prev.disabled = current <= 1;
  if (next) next.disabled = current >= total;
  if (text) text.textContent = total > 1 ? `Página ${current} de ${total}` : `${state.transactions.filter(t=>t.type==="expense").length} gastos`;
}

// ===================== SETTINGS =====================

function loadSettingsForm() {
  const na = document.getElementById("setting-name-a");
  const nb = document.getElementById("setting-name-b");
  const sa = document.getElementById("setting-salary-a");
  const sb = document.getElementById("setting-salary-b");
  if (na) na.value = state.people.personA?.name || "";
  if (nb) nb.value = state.people.personB?.name || "";
  if (sa) sa.value = state.people.personA?.salary || "";
  if (sb) sb.value = state.people.personB?.salary || "";
  updateSalaryShares();
}

function updateSalaryShares() {
  const sA = parseFloat(document.getElementById("setting-salary-a")?.value) || 0;
  const sB = parseFloat(document.getElementById("setting-salary-b")?.value) || 0;
  const total = sA + sB;
  // Use floor+remainder to guarantee exactly 100%
  let pA = total > 0 ? Math.floor((sA / total) * 100) : 50;
  let pB = total > 0 ? 100 - pA : 50;
  const elA = document.getElementById("share-pct-a");
  const elB = document.getElementById("share-pct-b");
  if (elA) elA.textContent = pA + "%";
  if (elB) elB.textContent = pB + "%";
}

// ===================== MODALS =====================

const txModal = document.getElementById("modal-transaction");
const confirmModal = document.getElementById("modal-confirm");
let confirmCallback = null;

function openModal(txId = null) {
  const form = document.getElementById("form-transaction");
  const title = document.getElementById("modal-title-text");
  form.reset();
  document.getElementById("transaction-id").value = "";
  document.getElementById("trans-date").value = new Date().toISOString().substring(0, 10);
  document.getElementById("trans-payer").value = "personA";

  document.querySelectorAll(".payer-btn").forEach(btn => btn.classList.remove("active","person-a-active","person-b-active"));
  const firstBtn = document.querySelector(".payer-btn[data-payer='personA']");
  if (firstBtn) firstBtn.classList.add("active","person-a-active");

  if (txId) {
    const t = state.transactions.find(tx => tx.id === txId);
    if (!t) return;
    title.textContent = "Editar Gasto";
    document.getElementById("transaction-id").value = t.id;
    document.getElementById("trans-amount").value = t.amount;
    document.getElementById("trans-desc").value = t.description;
    document.getElementById("trans-date").value = t.date;
    document.getElementById("trans-category").value = t.category;
    document.getElementById("trans-payer").value = t.payer || "personA";

    document.querySelectorAll(".payer-btn").forEach(btn => btn.classList.remove("active","person-a-active","person-b-active"));
    const activeBtn = document.querySelector(`.payer-btn[data-payer="${t.payer||'personA'}"]`);
    if (activeBtn) activeBtn.classList.add("active", t.payer === "personB" ? "person-b-active" : "person-a-active");
  } else {
    title.textContent = "Nuevo Gasto";
  }
  txModal.classList.add("active");
}

function closeModal() { txModal.classList.remove("active"); }

function confirmAction(title, msg, onAccept) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-message").textContent = msg;
  confirmCallback = onAccept;
  confirmModal.classList.add("active");
}

// ===================== POPULATE =====================

function populateCategorySelect() {
  const sel = document.getElementById("trans-category");
  const filt = document.getElementById("filter-category");
  [sel, filt].forEach((s, i) => {
    if (!s) return;
    while (s.options.length > (i === 1 ? 1 : 0)) s.remove(i === 1 ? 1 : 0);
    Object.entries(CATEGORIES).forEach(([key, cat]) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${cat.emoji} ${cat.name}`;
      s.appendChild(opt);
    });
  });
}

// ===================== RENDER ALL =====================

function renderAll() {
  updateNetHero();
  renderDashboardRecent();
  renderCategoryChart();
  renderPayerChart();
  renderTrendChart();
  renderTransactionsTable();
  loadSettingsForm();
}

// ===================== EVENT HANDLERS =====================

function initEventHandlers() {

  // ---- Shared tab switch helper ----
  function switchTab(tab) {
    // Top nav
    document.querySelectorAll(".nav-item").forEach(n => {
      n.classList.toggle("active", n.getAttribute("data-tab") === tab);
    });
    // Bottom nav
    document.querySelectorAll(".bottom-nav-item[data-tab]").forEach(n => {
      n.classList.toggle("active", n.getAttribute("data-tab") === tab);
    });
    // Panels
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    const panel = document.getElementById(`panel-${tab}`);
    if (panel) panel.classList.add("active");
    if (tab === "dashboard") {
      setTimeout(() => { renderCategoryChart(); renderPayerChart(); renderTrendChart(); }, 80);
    }
  }

  // Tabs — top navbar
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => switchTab(item.getAttribute("data-tab")));
  });

  // Tabs — bottom navbar
  document.querySelectorAll(".bottom-nav-item[data-tab]").forEach(item => {
    item.addEventListener("click", () => switchTab(item.getAttribute("data-tab")));
  });

  // FAB button (bottom nav)
  document.getElementById("bnav-add")?.addEventListener("click", () => openModal());

  // Modal open/close
  document.getElementById("btn-open-add-modal")?.addEventListener("click", () => openModal());
  document.getElementById("btn-close-modal")?.addEventListener("click", closeModal);
  document.getElementById("btn-cancel-modal")?.addEventListener("click", closeModal);

  // Payer selector buttons
  document.querySelectorAll(".payer-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".payer-btn").forEach(b => b.classList.remove("active","person-a-active","person-b-active"));
      const payer = btn.getAttribute("data-payer");
      btn.classList.add("active", payer === "personA" ? "person-a-active" : "person-b-active");
      document.getElementById("trans-payer").value = payer;
    });
  });

  // Form submit
  document.getElementById("form-transaction")?.addEventListener("submit", async e => {
    e.preventDefault();
    const id = document.getElementById("transaction-id").value;
    const amount = parseFloat(document.getElementById("trans-amount").value);
    const description = document.getElementById("trans-desc").value.trim();
    const category = document.getElementById("trans-category").value;
    const date = document.getElementById("trans-date").value;
    const payer = document.getElementById("trans-payer").value;

    if (!category) { alert("Seleccioná una categoría."); return; }

    const tx = { id: id || generateId(), type: "expense", amount, description, category, date, payer };

    if (id) {
      const idx = state.transactions.findIndex(t => t.id === id);
      if (idx !== -1) state.transactions[idx] = tx;
    } else {
      state.transactions.push(tx);
    }

    await saveState();
    closeModal();
    renderAll();
  });

  // Confirm modal
  document.getElementById("btn-confirm-accept")?.addEventListener("click", () => {
    if (confirmCallback) confirmCallback();
    confirmModal.classList.remove("active");
  });
  document.getElementById("btn-confirm-cancel")?.addEventListener("click", () => {
    confirmModal.classList.remove("active");
  });

  // Go to transactions
  document.getElementById("btn-go-to-transactions")?.addEventListener("click", () => {
    document.getElementById("btn-tab-transactions")?.click();
  });

  // Filters
  document.getElementById("input-search")?.addEventListener("input", e => {
    transactionFilters.search = e.target.value; currentPage = 1; renderTransactionsTable();
  });
  document.getElementById("filter-category")?.addEventListener("change", e => {
    transactionFilters.category = e.target.value; currentPage = 1; renderTransactionsTable();
  });
  document.getElementById("filter-payer")?.addEventListener("change", e => {
    transactionFilters.payer = e.target.value; currentPage = 1; renderTransactionsTable();
  });
  document.getElementById("btn-reset-filters")?.addEventListener("click", () => {
    transactionFilters = { search: "", category: "all", payer: "all", sortBy: "date", sortOrder: "desc" };
    document.getElementById("input-search").value = "";
    document.getElementById("filter-category").value = "all";
    document.getElementById("filter-payer").value = "all";
    currentPage = 1; renderTransactionsTable();
  });

  // Sort
  document.querySelectorAll(".sortable").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.getAttribute("data-sort");
      if (transactionFilters.sortBy === col) transactionFilters.sortOrder = transactionFilters.sortOrder === "asc" ? "desc" : "asc";
      else { transactionFilters.sortBy = col; transactionFilters.sortOrder = "desc"; }
      renderTransactionsTable();
    });
  });

  // Pagination
  document.getElementById("btn-prev-page")?.addEventListener("click", () => { currentPage--; renderTransactionsTable(); });
  document.getElementById("btn-next-page")?.addEventListener("click", () => { currentPage++; renderTransactionsTable(); });

  // Chart toggle
  document.getElementById("btn-chart-bar")?.addEventListener("click", () => {
    currentTrendType = "bar";
    document.getElementById("btn-chart-bar").classList.add("active");
    document.getElementById("btn-chart-line").classList.remove("active");
    renderTrendChart();
  });
  document.getElementById("btn-chart-line")?.addEventListener("click", () => {
    currentTrendType = "line";
    document.getElementById("btn-chart-line").classList.add("active");
    document.getElementById("btn-chart-bar").classList.remove("active");
    renderTrendChart();
  });

  // Settings save
  document.getElementById("btn-save-settings")?.addEventListener("click", async () => {
    state.people.personA.name = document.getElementById("setting-name-a").value.trim() || "Persona A";
    state.people.personB.name = document.getElementById("setting-name-b").value.trim() || "Persona B";
    state.people.personA.salary = parseFloat(document.getElementById("setting-salary-a").value) || 0;
    state.people.personB.salary = parseFloat(document.getElementById("setting-salary-b").value) || 0;
    await saveState();
    renderAll();
    const btn = document.getElementById("btn-save-settings");
    const original = btn.textContent;
    btn.textContent = "✓ Guardado";
    setTimeout(() => { btn.textContent = original; }, 2000);
  });

  // Live salary share preview
  document.getElementById("setting-salary-a")?.addEventListener("input", updateSalaryShares);
  document.getElementById("setting-salary-b")?.addEventListener("input", updateSalaryShares);

  // Copy share URL
  document.getElementById("btn-copy-url")?.addEventListener("click", () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById("btn-copy-url");
      btn.innerHTML = '<i data-lucide="check"></i> Copiado';
      if (typeof lucide !== "undefined") lucide.createIcons();
      setTimeout(() => { btn.innerHTML = '<i data-lucide="copy"></i> Copiar'; if (typeof lucide !== "undefined") lucide.createIcons(); }, 2000);
    });
  });

  // Demo


  // Export JSON
  document.getElementById("btn-export-json")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "cuentas_claras.json"; a.click();
    URL.revokeObjectURL(url);
  });

  // Export CSV
  document.getElementById("btn-export-csv")?.addEventListener("click", () => {
    const rows = [["Fecha","Descripcion","Categoria","Pago","Monto"]];
    state.transactions.filter(t => t.type === "expense").forEach(t =>
      rows.push([t.date, t.description, t.category, getPersonName(t.payer), t.amount])
    );
    const blob = new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "cuentas_claras.csv"; a.click();
    URL.revokeObjectURL(url);
  });

  // Import JSON
  document.getElementById("btn-import-json")?.addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (imported.transactions) {
          state = { ...state, ...imported };
          await saveState();
          loadSettingsForm();
          renderAll();
        }
      } catch { alert("Error importando el archivo."); }
    };
    reader.readAsText(file);
  });

  // Clear all data
  document.getElementById("btn-clear-all-data")?.addEventListener("click", () => {
    confirmAction("¿Borrar gastos?", "Se eliminarán todos los gastos. Las personas y sueldos se conservan.", async () => {
      state.transactions = [];
      await saveState();
      renderAll();
    });
  });

  // ---- SETTLE BALANCE BUTTON ----
  document.getElementById("btn-settle-balance")?.addEventListener("click", () => {
    const { net, debtor, creditor } = calculateSplit(null);
    if (!debtor || net < 0.5) return;

    const debtorName = getPersonName(debtor);
    const creditorName = getPersonName(creditor);
    const amountFormatted = formatCurrency(net);

    confirmAction(
      "Registrar transferencia",
      `Se registrará que ${debtorName} transfirió ${amountFormatted} a ${creditorName}. El saldo quedará en $0.`,
      async () => {
        // Register a settlement transaction: the debtor "pays" an expense assigned to the creditor
        // This effectively zeroes the balance by adding a transaction that covers the exact shortfall
        const today = new Date().toISOString().substring(0, 10);
        const settleTx = {
          id: generateId(),
          type: "settlement",
          amount: net,
          description: `Transferencia: ${debtorName} → ${creditorName}`,
          category: "Transferencia",
          date: today,
          payer: debtor,
          isSettlement: true
        };
        state.transactions.push(settleTx);
        await saveState();
        renderAll();

        // Momentary feedback
        const btn = document.getElementById("btn-settle-balance");
        if (btn) {
          btn.innerHTML = '<i data-lucide="check-circle-2"></i> <span>¡Saldado!</span>';
          btn.disabled = true;
          if (typeof lucide !== "undefined") lucide.createIcons();
          setTimeout(() => {
            btn.innerHTML = '<i data-lucide="handshake"></i> <span>Registrar transferencia y saldar</span>';
            btn.disabled = false;
            if (typeof lucide !== "undefined") lucide.createIcons();
          }, 3000);
        }
      }
    );
  });
}

// ===================== STARTUP =====================

function showApp() {
  document.getElementById("loading-screen")?.classList.add("hidden");
  document.getElementById("setup-screen")?.classList.add("hidden");
  document.getElementById("app")?.classList.remove("hidden");
}

async function startWithFirebase(config) {
  const ok = initFirebase(config);
  if (!ok) {
    alert("Error al conectar con Firebase. Verificá la configuración.");
    return false;
  }

  useFirebase = true;
  roomId = getRoomId();

  // Load local state as initial fallback
  try {
    const saved = localStorage.getItem("cc_state");
    if (saved) state = { ...state, ...JSON.parse(saved) };
  } catch(e) {}

  showApp();
  populateCategorySelect();
  initEventHandlers();

  // Check if room has data in Firestore, if not and we have local data, push it up
  try {
    const doc = await db.collection("rooms").doc(roomId).get();
    if (!doc.exists && state.transactions.length > 0) {
      await db.collection("rooms").doc(roomId).set(state);
    }
  } catch(e) {}

  // Start real-time listener (this calls renderAll)
  subscribeToRoom();
  setSyncStatus("online");
  return true;
}

function startWithLocalStorage() {
  useFirebase = false;
  roomId = null;

  try {
    const saved = localStorage.getItem("cc_state");
    if (saved) state = { ...state, ...JSON.parse(saved) };
  } catch(e) {}

  showApp();
  populateCategorySelect();
  initEventHandlers();
  setSyncStatus("local");
  renderAll();
}

// ===================== PIN SYSTEM =====================

let pinBuffer = "";
let pinMode = null; // "setup" | "entry"
let onPinSuccess = null;
let remotePinHash = null; // Stores the PIN hash downloaded from Firestore

function hashPin(pin) {
  let h = 0x5a3c9f;
  for (let i = 0; i < pin.length; i++) {
    h = ((h << 5) - h) + pin.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16);
}

function getPinStorageKey() {
  const id = roomId || "local";
  return `cc_pin_${id}`;
}

function getSessionKey() {
  const id = roomId || "local";
  return `cc_unlocked_${id}`;
}

function isPinUnlocked() {
  return sessionStorage.getItem(getSessionKey()) === "1";
}

function markPinUnlocked() {
  sessionStorage.setItem(getSessionKey(), "1");
}

function updatePinDots(containerId, count, isError = false) {
  const dots = document.querySelectorAll(`#${containerId} .pin-dot`);
  dots.forEach((dot, i) => {
    dot.classList.remove("filled", "error");
    if (isError) dot.classList.add("error");
    else if (i < count) dot.classList.add("filled");
  });
}

function shakeDots(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.classList.remove("shake");
  void container.offsetWidth;
  container.classList.add("shake");
  setTimeout(() => container.classList.remove("shake"), 500);
}

function showPinSetup(onSuccess) {
  pinMode = "setup";
  pinBuffer = "";
  onPinSuccess = onSuccess;
  updatePinDots("setup-dots", 0);
  document.querySelectorAll(".pin-screen").forEach(s => s.classList.add("hidden"));
  document.getElementById("pin-setup-screen").classList.remove("hidden");
  if (typeof lucide !== "undefined") lucide.createIcons();
}

function showPinEntry(onSuccess) {
  pinMode = "entry";
  pinBuffer = "";
  onPinSuccess = onSuccess;
  updatePinDots("entry-dots", 0);
  const desc = document.getElementById("pin-entry-desc");
  if (desc) desc.textContent = "Ingresá tu PIN para continuar";
  document.querySelectorAll(".pin-screen").forEach(s => s.classList.add("hidden"));
  document.getElementById("pin-entry-screen").classList.remove("hidden");
  if (typeof lucide !== "undefined") lucide.createIcons();
}

function hidePinScreens() {
  document.querySelectorAll(".pin-screen").forEach(s => s.classList.add("hidden"));
}

function handlePinDigit(digit) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += digit;
  const dotsId = pinMode === "setup" ? "setup-dots" : "entry-dots";
  updatePinDots(dotsId, pinBuffer.length);

  if (pinBuffer.length === 4) {
    setTimeout(async () => {
      const hashed = hashPin(pinBuffer);
      if (pinMode === "setup") {
        // Save locally
        localStorage.setItem(getPinStorageKey(), hashed);
        
        // Save to Firebase state settings if in firebase mode
        if (useFirebase && state) {
          if (!state.settings) state.settings = {};
          state.settings.pinHash = hashed;
          await saveState();
        }
        
        markPinUnlocked();
        hidePinScreens();
        pinBuffer = "";
        if (onPinSuccess) onPinSuccess();
      } else {
        // Compare with Firebase hash if available, otherwise local storage hash
        const targetHash = useFirebase ? (remotePinHash || localStorage.getItem(getPinStorageKey())) : localStorage.getItem(getPinStorageKey());
        
        if (targetHash === hashed) {
          // Store locally to avoid redownloads and mark session unlocked
          localStorage.setItem(getPinStorageKey(), hashed);
          markPinUnlocked();
          hidePinScreens();
          pinBuffer = "";
          if (onPinSuccess) onPinSuccess();
        } else {
          updatePinDots("entry-dots", 4, true);
          shakeDots("entry-dots");
          const desc = document.getElementById("pin-entry-desc");
          if (desc) desc.textContent = "PIN incorrecto, intentá de nuevo";
          pinBuffer = "";
          setTimeout(() => {
            updatePinDots("entry-dots", 0);
            if (desc) desc.textContent = "Ingresá tu PIN para continuar";
          }, 1200);
        }
      }
    }, 120);
  }
}

function handlePinDelete() {
  if (pinBuffer.length === 0) return;
  pinBuffer = pinBuffer.slice(0, -1);
  const dotsId = pinMode === "setup" ? "setup-dots" : "entry-dots";
  updatePinDots(dotsId, pinBuffer.length);
}

function initPinKeypad(screenId, deleteId) {
  const screen = document.getElementById(screenId);
  if (!screen) return;
  screen.querySelectorAll(".pin-key[data-digit]").forEach(btn => {
    btn.addEventListener("click", () => handlePinDigit(btn.getAttribute("data-digit")));
  });
  document.getElementById(deleteId)?.addEventListener("click", handlePinDelete);
}

// Physical keyboard support
document.addEventListener("keydown", e => {
  if (pinMode && e.key >= "0" && e.key <= "9") handlePinDigit(e.key);
  if (pinMode && (e.key === "Backspace" || e.key === "Delete")) handlePinDelete();
});

async function checkPinThenProceed(onUnlocked) {
  if (useFirebase && db && roomId) {
    try {
      // Show loader while checking Firebase
      document.getElementById("loading-screen")?.classList.remove("hidden");
      
      const doc = await db.collection("rooms").doc(roomId).get();
      document.getElementById("loading-screen")?.classList.add("hidden");
      
      if (doc.exists && doc.data().settings?.pinHash) {
        remotePinHash = doc.data().settings.pinHash;
        if (isPinUnlocked()) {
          onUnlocked();
        } else {
          showPinEntry(onUnlocked);
        }
      } else {
        // No PIN exists in the database room yet (first time set up)
        showPinSetup(onUnlocked);
      }
    } catch(e) {
      console.error("Error reading PIN from Firebase:", e);
      // Fallback to local PIN check if offline
      document.getElementById("loading-screen")?.classList.add("hidden");
      const localHash = localStorage.getItem(getPinStorageKey());
      if (localHash) {
        if (isPinUnlocked()) onUnlocked();
        else showPinEntry(onUnlocked);
      } else {
        showPinSetup(onUnlocked);
      }
    }
  } else {
    // Local mode PIN check
    const localHash = localStorage.getItem(getPinStorageKey());
    if (localHash) {
      if (isPinUnlocked()) onUnlocked();
      else showPinEntry(onUnlocked);
    } else {
      showPinSetup(onUnlocked);
    }
  }
}

// ===================== STARTUP =====================

document.addEventListener("DOMContentLoaded", () => {
  initPinKeypad("pin-setup-screen", "setup-delete");
  initPinKeypad("pin-entry-screen", "entry-delete");

  document.getElementById("btn-save-firebase-config")?.addEventListener("click", async () => {
    const raw = document.getElementById("firebase-config-input")?.value.trim();
    if (!raw) { alert("Pegá tu configuración de Firebase."); return; }
    try {
      const config = JSON.parse(raw);
      if (!config.apiKey || !config.projectId) { alert("La configuración parece incompleta."); return; }
      localStorage.setItem("cc_firebase_config", JSON.stringify(config));
      document.getElementById("setup-screen").classList.add("hidden");
      document.getElementById("loading-screen")?.classList.remove("hidden");
      await startWithFirebase(config);
    } catch(e) {
      alert("JSON inválido. Revisá que hayas copiado el objeto completo.");
    }
  });

  document.getElementById("btn-use-local")?.addEventListener("click", () => {
    localStorage.setItem("cc_seen_before", "1");
    checkPinThenProceed(() => {
      startWithLocalStorage();
    });
  });

  init();
});

async function init() {
  if (typeof lucide !== "undefined") lucide.createIcons();

  // Try to use the hardcoded config first, fall back to localStorage
  const savedConfig = localStorage.getItem("cc_firebase_config");
  let configToUse = null;
  
  if (typeof HARDCODED_FIREBASE_CONFIG !== "undefined" && HARDCODED_FIREBASE_CONFIG.apiKey) {
    configToUse = HARDCODED_FIREBASE_CONFIG;
  } else if (savedConfig) {
    try {
      configToUse = JSON.parse(savedConfig);
    } catch(e) {
      localStorage.removeItem("cc_firebase_config");
    }
  }

  if (configToUse) {
    try {
      const ok = initFirebase(configToUse);
      if (ok) {
        useFirebase = true;
        roomId = getRoomId();
        checkPinThenProceed(() => startWithFirebase(configToUse));
        return;
      }
    } catch(e) {
      console.error("Error starting Firebase:", e);
    }
  }

  // Local mode — use hash as room ID for PIN isolation
  roomId = getRoomId();

  const hasLocalData = localStorage.getItem("cc_state");
  if (hasLocalData) {
    checkPinThenProceed(() => startWithLocalStorage());
    return;
  }

  const isFirstTime = !localStorage.getItem("cc_seen_before");
  if (isFirstTime) {
    localStorage.setItem("cc_seen_before", "1");
    checkPinThenProceed(() => {
      startWithLocalStorage();
    });
  } else {
    checkPinThenProceed(() => startWithLocalStorage());
  }
}


