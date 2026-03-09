import { api, downloadScanExport } from "./api.js";
import { app, clearLastScan, isManagerRole, resetSession, setLastScan, setNotice, setSimpleMode, state, stationLabels } from "./state.js";

function playScanTone(ok) {
  const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextImpl) return;

  const context = new AudioContextImpl();
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = ok ? 880 : 220;
  gain.gain.value = 0.0001;

  oscillator.connect(gain);
  gain.connect(context.destination);

  const now = context.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (ok ? 0.16 : 0.24));

  oscillator.start(now);
  oscillator.stop(now + (ok ? 0.17 : 0.25));

  oscillator.onended = () => context.close().catch(() => {});
}

export async function runScanFromInput(station, inputId, renderApp) {
  const input = document.getElementById(inputId);
  if (!input) {
    setLastScan({ station, ok: false, code: "", message: "Поле сканирования не найдено." });
    setNotice("error", "Поле сканирования не найдено.");
    await renderApp();
    return;
  }
  const code = input.value.trim();
  if (!code) {
    setLastScan({ station, ok: false, code: "", message: "Пустой QR-код." });
    setNotice("warn", "Скан не выполнен: пустой QR-код.");
    await renderApp();
    const refreshedInput = document.getElementById(inputId);
    if (refreshedInput) refreshedInput.focus();
    return;
  }

  try {
    const result = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({ station, qrCode: code })
    });
    state.selectedOrderId = result.order.id;
    setLastScan({ station, ok: true, code, message: result.message });
    setNotice("ok", result.message);
    playScanTone(true);
    input.value = "";
  } catch (error) {
    setLastScan({ station, ok: false, code, message: error.message });
    setNotice("error", error.message);
    playScanTone(false);
  }

  await renderApp();
  const refreshedInput = document.getElementById(inputId);
  if (refreshedInput) {
    refreshedInput.focus();
    refreshedInput.select();
  }
}

export function bindGlobalActions(renderApp, renderLogin) {
  const stationPickerButton = document.getElementById("station-picker-button");
  if (stationPickerButton) {
    stationPickerButton.addEventListener("click", async () => {
      state.screen = "station-picker";
      state.deniedStation = null;
      await renderApp();
    });
  }

  const homeStationButton = document.getElementById("home-station-button");
  if (homeStationButton) {
    homeStationButton.addEventListener("click", async () => {
      state.screen = "station";
      clearLastScan();
      await renderApp();
    });
  }

  const simpleModeToggle = document.getElementById("simple-mode-toggle");
  if (simpleModeToggle) {
    simpleModeToggle.addEventListener("click", async () => {
      setSimpleMode(!state.simpleMode);
      setNotice("ok", `Простой режим ${state.simpleMode ? "включён" : "выключен"}.`);
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-open-station]")) {
    button.addEventListener("click", async () => {
      const station = button.dataset.openStation;
      try {
        await api("/api/open-station", {
          method: "POST",
          body: JSON.stringify({ station })
        });
        state.currentStation = station;
        state.screen = "station";
        state.deniedStation = null;
        clearLastScan();
        if (station !== "overview") {
          setNotice("ok", `${stationLabels[station]} открыта.`);
        }
      } catch (error) {
        if (error.status === 403) {
          state.deniedStation = {
            station,
            label: error.payload?.label || stationLabels[station] || station
          };
          state.screen = "forbidden";
          setNotice("error", `Доступ запрещён для ${state.deniedStation.label}.`);
        } else {
          setNotice("error", error.message);
        }
      }
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-open-order]")) {
    button.addEventListener("click", async () => {
      state.selectedOrderId = Number(button.dataset.openOrder);
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-create-baskets]")) {
    button.addEventListener("click", async () => {
      try {
        await api("/api/sorting/create-baskets", {
          method: "POST",
          body: JSON.stringify({ orderId: Number(button.dataset.createBaskets) })
        });
        state.currentStation = isManagerRole() ? "washing" : "sorting";
        state.screen = "station";
        state.selectedOrderId = Number(button.dataset.createBaskets);
        clearLastScan();
        setNotice("ok", isManagerRole() ? "Корзины созданы. Заказ переведён на Стирку." : "Корзины созданы. Заказ готов к передаче на стирку.");
      } catch (error) {
        setNotice("error", error.message);
      }
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-run-scan]")) {
    button.addEventListener("click", async () => {
      const station = button.dataset.runScan;
      const inputId = button.dataset.scanInputId || (station === "pickup" ? "pickup-scan-input" : "scan-input");
      await runScanFromInput(station, inputId, renderApp);
    });
  }

  for (const input of app.querySelectorAll("[data-scan-input-for]")) {
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const station = input.dataset.scanInputFor;
      await runScanFromInput(station, input.id, renderApp);
    });
  }

  for (const button of app.querySelectorAll("[data-complete-pickup]")) {
    button.addEventListener("click", async () => {
      try {
        const result = await api("/api/pickup/complete", {
          method: "POST",
          body: JSON.stringify({ orderId: Number(button.dataset.completePickup) })
        });
        state.currentStation = isManagerRole() ? "overview" : "pickup";
        state.screen = "station";
        state.selectedOrderId = result.order.id;
        setNotice("ok", "Выдача завершена. Статус поставлен в очередь синхронизации.");
      } catch (error) {
        setNotice("error", error.message);
      }
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-demo-reset]")) {
    button.addEventListener("click", async () => {
      const confirmed = window.confirm("Сбросить демо-данные к начальному сценарию?");
      if (!confirmed) {
        return;
      }
      try {
        await api("/api/demo/reset", { method: "POST" });
        state.screen = "station-picker";
        state.currentStation = null;
        state.selectedOrderId = null;
        state.deniedStation = null;
        clearLastScan();
        setNotice("ok", "Демо-данные сброшены. Сценарий восстановлен.");
      } catch (error) {
        setNotice("error", error.message);
      }
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-run-sync-now]")) {
    button.addEventListener("click", async () => {
      try {
        await api("/api/sync/run", { method: "POST", body: JSON.stringify({}) });
        setNotice("ok", "Очередь синхронизации запущена вручную.");
      } catch (error) {
        setNotice("error", error.message);
      }
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-export-scans]")) {
    button.addEventListener("click", async () => {
      const format = button.dataset.exportScans;
      try {
        await downloadScanExport(format);
        setNotice("ok", `Лог сканов экспортирован в ${format.toUpperCase()}.`);
      } catch (error) {
        setNotice("error", error.message);
      }
      await renderApp();
    });
  }

  for (const button of app.querySelectorAll("[data-export-order]")) {
    button.addEventListener("click", async () => {
      const format = button.dataset.exportOrder;
      if (!state.selectedOrderId) {
        setNotice("warn", "Сначала выберите заказ для экспорта его сканов.");
        await renderApp();
        return;
      }
      try {
        await downloadScanExport(format, state.selectedOrderId);
        setNotice("ok", `Сканы заказа ${state.selectedOrderId} экспортированы в ${format.toUpperCase()}.`);
      } catch (error) {
        setNotice("error", error.message);
      }
      await renderApp();
    });
  }

  const backToStations = document.getElementById("back-to-stations");
  if (backToStations) {
    backToStations.addEventListener("click", async () => {
      state.screen = "station-picker";
      state.deniedStation = null;
      await renderApp();
    });
  }

  const logoutFromDenied = document.getElementById("logout-from-denied");
  if (logoutFromDenied) {
    logoutFromDenied.addEventListener("click", async () => {
      try {
        await api("/api/logout", { method: "POST" });
      } catch {
        // ignore
      }
      resetSession();
      renderLogin();
    });
  }

  const logoutButton = document.getElementById("logout-button");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      try {
        await api("/api/logout", { method: "POST" });
      } catch {
        // ignore
      }
      resetSession();
      renderLogin();
    });
  }

  const focusTarget = document.getElementById("simple-scan-input") || document.getElementById("scan-input") || document.getElementById("pickup-scan-input");
  if (focusTarget) {
    setTimeout(() => focusTarget.focus(), 0);
  }
}
