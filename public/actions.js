import { api, downloadScanExport } from "./api.js";
import { app, isManagerRole, resetSession, setNotice, setSimpleMode, state, stationLabels } from "./state.js";

export async function runScanFromInput(station, inputId, renderApp) {
  const input = document.getElementById(inputId);
  if (!input) {
    setNotice("error", "Поле сканирования не найдено.");
    await renderApp();
    return;
  }

  try {
    const result = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({ station, qrCode: input.value })
    });
    state.selectedOrderId = result.order.id;
    setNotice("ok", result.message);
    input.value = "";
  } catch (error) {
    setNotice("error", error.message);
  }

  await renderApp();
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
        setNotice("ok", "Демо-данные сброшены. Сценарий восстановлен.");
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
