mapboxgl.accessToken =
  "pk.eyJ1IjoiY2hsb2VjYW8iLCJhIjoiY21vNzVubHE5MDNuNDJyczZhczcydmtxMiJ9.uzr1odliJZuV4e8AEsfYVg";

const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/light-v11",
  center: [10.145, 54.32],
  zoom: 11,
});

let treeMarkers = [];
let dwdMarkers = [];
let customMarkers = []; // 💡 NEW: Trackers for your proprietary station markers
let activeTree = null; // Tracks selected tree for reactive interpolation

// --- 1. RADIUS SLIDER UI ---
const slider = document.getElementById("radius-slider");
const radiusLabel = document.getElementById("radius-val");

slider.addEventListener("input", (e) => {
  radiusLabel.innerText = `${e.target.value / 1000}km`;
});

slider.addEventListener("change", () => {
  updateMapLayers();
});

// --- 2. LOCALIZED LAYER UPDATE ---
async function updateMapLayers() {
  const radius = slider.value;
  console.log(`🔍 Refreshing local layers for ${radius / 1000}km...`);

  try {
    const response = await fetch(
      `http://localhost:3000/api/map-data?radius=${radius}`,
    );
    const data = await response.json();

    // Clear old DWD markers (Synop network remains clean)
    dwdMarkers.forEach((m) => m.remove());
    dwdMarkers = [];

    // 💡 NEW: Clear old custom proprietary markers
    customMarkers.forEach((m) => m.remove());
    customMarkers = [];

    const bounds = new mapboxgl.LngLatBounds();

    // --- RENDER DWD SYNOP STATIONS (Unchanged Logic) ---
    data.stations.features.forEach((station) => {
      const sId = station.properties.source_id;
      const sName = station.properties.name;
      const sCoords = station.geometry.coordinates;

      const el = document.createElement("div");
      el.className = "marker dwd-marker";

      const marker = new mapboxgl.Marker(el).setLngLat(sCoords).addTo(map);
      dwdMarkers.push(marker);
      bounds.extend(sCoords);

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        fetchDWDLive(sId, sCoords, sName);
      });
    });

    // 💡 NEW: RENDER CUSTOM PROPRIETARY WEATHER STATIONS ---
    if (data.customStations && data.customStations.features) {
      data.customStations.features.forEach((station) => {
        const sId = station.properties.station_id;
        const sName = station.properties.name;
        const sCoords = station.geometry.coordinates;

        const el = document.createElement("div");
        el.className = "marker custom-marker"; // Distinct orange class style

        const marker = new mapboxgl.Marker(el).setLngLat(sCoords).addTo(map);
        customMarkers.push(marker);
        bounds.extend(sCoords);

        el.addEventListener("click", (e) => {
          e.stopPropagation();
          fetchCustomStationLive(sId, sCoords, sName);
        });
      });
    }

    // LOCAL VIEW LOGIC:
    // If multiple stations are found across arrays, show the bounding area.
    const totalStations =
      data.stations.features.length +
      (data.customStations?.features.length || 0);
    if (totalStations > 1) {
      map.fitBounds(bounds, { padding: 80, maxZoom: 12 });
    } else if (totalStations === 1) {
      map.easeTo({ zoom: 11 });
    }

    // Update open tree analysis with new localized baseline
    if (activeTree) {
      fetchTreeDetails(activeTree.id, activeTree.coords);
    }
  } catch (err) {
    console.error("❌ Layer Update Error:", err);
  }
}

map.on("load", async () => {
  console.log("🌐 Initializing Local Map...");
  updateMapLayers();

  try {
    const response = await fetch("http://localhost:3000/api/map-data");
    const data = await response.json();

    data.trees.features.forEach((tree) => {
      const tId = tree.properties.tree_id;
      const tCoords = tree.geometry.coordinates;

      const el = document.createElement("div");
      el.className = "marker tree-marker";
      const marker = new mapboxgl.Marker(el).setLngLat(tCoords).addTo(map);
      treeMarkers.push(marker);

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        fetchTreeDetails(tId, tCoords);
      });
    });

    // Toggle Listeners
    document.getElementById("tree-toggle").addEventListener("change", (e) => {
      treeMarkers.forEach((m) =>
        e.target.checked ? m.addTo(map) : m.remove(),
      );
    });
    document.getElementById("dwd-toggle").addEventListener("change", (e) => {
      dwdMarkers.forEach((m) => (e.target.checked ? m.addTo(map) : m.remove()));
    });

    // 💡 NEW: Handle toggle changes for internal proprietary hardware switches
    document.getElementById("custom-toggle").addEventListener("change", (e) => {
      customMarkers.forEach((m) =>
        e.target.checked ? m.addTo(map) : m.remove(),
      );
    });
  } catch (err) {
    console.error("❌ Tree Initialization Error:", err);
  }
});

// --- HELPER: DWD LIVE POPUP (Synop Network Core) ---
async function fetchDWDLive(sourceId, coords, name) {
  const popup = new mapboxgl.Popup({ offset: 25, closeOnClick: true })
    .setLngLat(coords)
    .setHTML(`<div style="padding:5px; color: #333;">⏳ Fetching...</div>`)
    .addTo(map);

  try {
    const res = await fetch(
      `http://localhost:3000/api/dwd-live/${sourceId}?_cb=${Date.now()}`,
    );
    const live = await res.json();

    const obsTime = new Date(live.time);
    const timeDisplay =
      obsTime > new Date()
        ? "Live Forecast"
        : obsTime.toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
          });

    popup.setHTML(`
      <div style="font-family: sans-serif; padding: 5px; min-width: 170px; color: #333;"> 
        <b style="color: #2980b9; font-size: 1.1em;">🌦️ ${name}</b><br>
        <div style="margin-top: 8px; border-top: 1px solid #eee; padding-top: 8px;">
            <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
                <span>🌡️ Temp:</span><b>${live.temp}°C</b>
            </div>
            <div style="display:flex; justify-content:space-between;">
                <span>💧 Humidity:</span><b>${live.humidity}%</b>
            </div>
            <div style="margin-top:12px; font-size:0.75em; color:#7f8c8d; border-top: 1px dashed #eee; padding-top: 5px;">
                ID: ${sourceId} | Time: ${timeDisplay}
            </div>
        </div>
      </div>
    `);
  } catch (err) {
    popup.setHTML(
      `<div style="color:red; padding:5px;">Station unavailable</div>`,
    );
  }
}

// 💡 NEW HELPER: PROPRIETARY EQUIPMENT REAL-TIME TELEMETRY POPUP ---
async function fetchCustomStationLive(stationId, coords, name) {
  const popup = new mapboxgl.Popup({ offset: 25, closeOnClick: true })
    .setLngLat(coords)
    .setHTML(
      `<div style="padding:5px; color: #333;">⏳ Accessing hardware array...</div>`,
    )
    .addTo(map);

  try {
    const res = await fetch(
      `http://localhost:3000/api/custom-live/${stationId}?_cb=${Date.now()}`,
    );
    const live = await res.json();

    popup.setHTML(`
      <div style="font-family: sans-serif; padding: 5px; min-width: 180px; color: #333;"> 
        <b style="color: #e67e22; font-size: 1.1em;">🛡️ ${name}</b><br>
        <span style="font-size:0.75em; color:#95a5a6;">Proprietary Sensor Node</span>
        <div style="margin-top: 8px; border-top: 1px solid #eee; padding-top: 8px;">
            <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
                <span>🌡️ Temperature:</span><b>${live.temp !== "N/A" ? `${live.temp}°C` : "N/A"}</b>
            </div>
            <div style="display:flex; justify-content:space-between;">
                <span>💧 Air Humidity:</span><b>${live.humidity !== "N/A" ? `${live.humidity}%` : "N/A"}</b>
            </div>
            <div style="margin-top:12px; font-size:0.75em; color:#7f8c8d; border-top: 1px dashed #eee; padding-top: 5px; display:flex; justify-content:space-between;">
                <span>ID: <b>${stationId}</b></span>
                <span>Logged: ${live.time !== "N/A" ? new Date(live.time).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "N/A"}</span>
            </div>
        </div>
      </div>
    `);
  } catch (err) {
    popup.setHTML(
      `<div style="color:red; padding:5px;">Hardware offline</div>`,
    );
  }
}

// --- HELPER: TREE SIDEBAR (Localized Interpolation) ---
async function fetchTreeDetails(treeId, coords) {
  activeTree = { id: treeId, coords: coords };
  const radius = slider.value;
  const panel = document.getElementById("analysis-panel");

  panel.innerHTML = `<h3 style="text-align:center;">Analyzing ${radius / 1000}km Microclimate...</h3>`;
  map.flyTo({ center: coords, zoom: 12 });

  try {
    const res = await fetch(
      `http://localhost:3000/api/details/${treeId}?radius=${radius}&_cb=${Date.now()}`,
    );
    const data = await res.json();
    const { sensor, dwd, name } = data;

    const deltaTemp = (sensor.cli_temperature - dwd.temp).toFixed(2);

    panel.innerHTML = `
      <h2 style="margin:0; color:#2c3e50;">${name}</h2>
      <div class="timestamp">🕒 Last Sensor: ${new Date(sensor.time_at || sensor.timestamp).toLocaleString("de-DE")}</div>
      
      <div style="background:#f8f9fa; padding:15px; border-radius:10px; border-left: 5px solid ${deltaTemp > 0 ? "#ff4e50" : "#00dbde"}; margin-bottom:15px;">
        <div class="delta-val" style="color:${deltaTemp > 0 ? "#ff4e50" : "#00dbde"}">
            ${deltaTemp > 0 ? "+" : ""}${deltaTemp}°C
        </div>
        <p style="text-align:center; font-size:0.8em; margin:0; color:#666; font-weight:bold; text-transform:uppercase;">Microclimate Delta</p>
        <hr style="border:0; border-top:1px solid #ddd; margin:10px 0;">
        <div style="display:flex; justify-content:space-between; font-size:0.9em;">
            <span>🌳 Tree Sensor:</span><b>${sensor.cli_temperature}°C</b>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:0.9em; margin-top:5px;">
            <span>🌦️ Regional Baseline:</span><b>${dwd.temp ?? "N/A"}°C</b>
        </div>
      </div>

      <div style="background:#eef6ff; padding:15px; border-radius:10px; border-left: 5px solid #3498db;">
        <p style="margin:0 0 10px 0; font-size:0.85em; font-weight:bold; color:#2980b9; text-transform:uppercase;">💧 Humidity Comparison</p>
        <div style="display:flex; justify-content:space-between; font-size:0.9em;">
            <span>🌳 Tree Sensor:</span><b>${sensor.cli_humidity ?? "N/A"}%</b>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:0.9em; margin-top:5px;">
            <span>🌦️ DWD Baseline:</span><b>${dwd.humidity ?? "N/A"}%</b>
        </div>
      </div>
      <div style="margin-top: 15px; font-size: 0.75em; color: #95a5a6; font-style: italic; text-align: center;">
        Interpolation Method: ${dwd.method}
      </div>
    `;
  } catch (err) {
    panel.innerHTML = `<h3 style="color:red;">Error</h3><p>${err.message}</p>`;
  }
}
