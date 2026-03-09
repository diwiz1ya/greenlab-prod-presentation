import { api } from "./api.js";
import { bindGlobalActions } from "./actions.js";
import { renderLogin } from "./render/login.js";
import { renderOrderDetails, renderOverview, renderPickup, renderSorting, renderSyncQueue } from "./render/orders.js";
import { renderScanScreen, renderSimpleScanMode } from "./render/scan.js";
import { renderDemoControls, renderHero, renderNoAccess, renderSimpleWorkerHome, renderStationPicker } from "./render/stations.js";
import { app, applyRoleDefaults, consumeNotice, getAllowedStations, isManagerRole, isScanStation, resetSession, state, stationLabels } from "./state.js";
import { escapeHtml } from "./utils.js";

function showLogin(error) {
  renderLogin(renderApp, error);
}

boot();

async function boot() {
  if (!state.token) {
    showLogin();
    return;
  }

  try {
    const session = await api("/api/session");
    state.user = session.user;
    state.screen = "station-picker";
    applyRoleDefaults();
    await renderApp();
  } catch {
    resetSession();
    showLogin();
  }
}

async function renderApp() {
  const allowedStations = getAllowedStations();
  const [stationsResponse, overview, syncQueue] = await Promise.all([
    api("/api/stations"),
    allowedStations.includes("overview") ? api("/api/overview") : Promise.resolve({ counts: {}, orders: [] }),
    api("/api/sync-queue")
  ]);

  const notice = consumeNotice();
  const stationData = {};
  await Promise.all(
    stationsResponse.stations
      .filter((station) => station.allowed && station.key !== "overview")
      .map(async (station) => {
        stationData[station.key] = await api(`/api/orders?station=${station.key}`);
      })
  );

  let orderDetails = null;
  if (state.selectedOrderId) {
    try {
      orderDetails = await api(`/api/orders/${state.selectedOrderId}`);
    } catch {
      state.selectedOrderId = null;
    }
  }

  let recentScans = [];
  if (state.screen === "station" && isScanStation(state.currentStation)) {
    try {
      const recent = await api(`/api/scans/recent?station=${state.currentStation}&limit=8`);
      recentScans = recent.rows || [];
    } catch {
      recentScans = [];
    }
  }

  const canToggleSimple = isManagerRole() && state.screen === "station" && isScanStation(state.currentStation);

  const content = renderScreenContent({
    stations: stationsResponse.stations,
    overview,
    stationData,
    orderDetails,
    syncQueue,
    notice,
    recentScans
  });

  app.innerHTML = `
    <section class="shell">
      <div class="topbar panel">
        <div>
          <div class="eyebrow">Вы вошли как</div>
          <strong>${escapeHtml(state.user.displayName)}</strong>
          <div class="muted">${escapeHtml(state.user.role)}</div>
        </div>
        <nav>
          ${isManagerRole() ? '<button class="secondary" id="station-picker-button">Станции</button>' : ""}
          ${isManagerRole() && state.currentStation ? `<button class="ghost" id="home-station-button">${escapeHtml(stationLabels[state.currentStation])}</button>` : ""}
          ${!isManagerRole() && state.currentStation ? `<span class="pill">${escapeHtml(stationLabels[state.currentStation])}</span>` : ""}
          ${canToggleSimple ? `<button class="ghost" id="simple-mode-toggle">Простой режим: ${state.simpleMode ? "ВКЛ" : "ВЫКЛ"}</button>` : ""}
          <button class="ghost" id="logout-button">Выйти</button>
        </nav>
      </div>
      ${content}
    </section>
  `;

  bindGlobalActions(renderApp, () => showLogin());
}

function renderScreenContent({ stations, overview, stationData, orderDetails, syncQueue, notice, recentScans }) {
  const managerView = isManagerRole();
  const forceSimpleOperatorView = state.screen === "station" && !managerView && isScanStation(state.currentStation);
  const simpleScanView = state.screen === "station" && isScanStation(state.currentStation) && (state.simpleMode || forceSimpleOperatorView);

  if (state.screen === "station-picker") {
    if (!managerView && state.currentStation) {
      return `
        ${notice ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}</div>` : ""}
        ${renderSimpleWorkerHome()}
      `;
    }

    return `
      ${notice ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}</div>` : ""}
      ${renderHero(overview.counts)}
      ${renderStationPicker(stations)}
      ${renderDemoControls()}
      ${renderSyncQueue(syncQueue)}
    `;
  }

  if (state.screen === "forbidden") {
    return `
      ${notice ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}</div>` : ""}
      ${renderNoAccess()}
      ${managerView ? renderStationPicker(stations) : ""}
      ${managerView ? renderDemoControls() : ""}
    `;
  }

  if (simpleScanView) {
    return `
      ${notice ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}</div>` : ""}
      ${renderSimpleScanMode(state.currentStation, stationData[state.currentStation]?.orders || [], recentScans)}
      ${orderDetails ? renderOrderDetails(orderDetails) : ""}
      ${managerView ? renderDemoControls() : ""}
      ${managerView ? renderSyncQueue(syncQueue) : ""}
    `;
  }

  if (!managerView && state.screen === "station") {
    return `
      ${notice ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}</div>` : ""}
      ${state.currentStation === "overview" ? renderOverview(overview.orders) : ""}
      ${state.currentStation === "sorting" ? renderSorting(stationData.sorting?.orders || []) : ""}
      ${state.currentStation === "washing" ? renderScanScreen("washing", stationData.washing?.orders || []) : ""}
      ${state.currentStation === "qc" ? renderScanScreen("qc", stationData.qc?.orders || []) : ""}
      ${state.currentStation === "drying" ? renderScanScreen("drying", stationData.drying?.orders || []) : ""}
      ${state.currentStation === "ironing" ? renderScanScreen("ironing", stationData.ironing?.orders || []) : ""}
      ${state.currentStation === "pickup" ? renderPickup(stationData.pickup?.orders || []) : ""}
      ${orderDetails ? renderOrderDetails(orderDetails) : ""}
    `;
  }

  return `
    ${notice ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}</div>` : ""}
    ${renderHero(overview.counts)}
    ${renderStationPicker(stations, true)}
    ${renderDemoControls()}
    ${state.currentStation === "overview" ? renderOverview(overview.orders) : ""}
    ${state.currentStation === "sorting" ? renderSorting(stationData.sorting?.orders || []) : ""}
    ${state.currentStation === "washing" ? renderScanScreen("washing", stationData.washing?.orders || []) : ""}
    ${state.currentStation === "qc" ? renderScanScreen("qc", stationData.qc?.orders || []) : ""}
    ${state.currentStation === "drying" ? renderScanScreen("drying", stationData.drying?.orders || []) : ""}
    ${state.currentStation === "ironing" ? renderScanScreen("ironing", stationData.ironing?.orders || []) : ""}
    ${state.currentStation === "pickup" ? renderPickup(stationData.pickup?.orders || []) : ""}
    ${renderOrderDetails(orderDetails)}
    ${renderSyncQueue(syncQueue)}
  `;
}
