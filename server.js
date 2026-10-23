import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const { FAST_API_URL, FAST_API_USER, FAST_API_PASSWORD } = process.env;
const port = 3000;

// --- UTILITY: Haversine Formula (Calculates distance in km) ---
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getAuthToken() {
  const res = await fetch(`${FAST_API_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username: FAST_API_USER,
      password: FAST_API_PASSWORD,
    }),
  });
  const data = await res.json();
  return data.access_token;
}

// ROUTE 1: Global Map Data (Trees + Synop Stations + Custom Internal Network)
app.get("/api/map-data", async (req, res) => {
  try {
    const token = await getAuthToken();
    const radius = req.query.radius || 100000;

    const synopUrl = `${FAST_API_URL}/v1/dwd-synop?lat=54.32&lon=10.12&max_dist=${radius}&tz=Europe/Berlin`;
    const treeUrl = `${FAST_API_URL}/v1/trees`;
    const customStationsUrl = `${FAST_API_URL}/v1/weather-station`;

    const [tRes, dRes, cRes] = await Promise.all([
      fetch(treeUrl, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(synopUrl, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(customStationsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    const trees = await tRes.json();
    const dwdRaw = await dRes.json();
    const customRaw = await cRes.json();

    const realTrees = trees.filter(
      (t) => t.tree_id === "tree-001" || t.tree_id === "tree-002",
    );
    const stationList = dwdRaw.sources || dwdRaw.stations || [];

    res.json({
      trees: {
        type: "FeatureCollection",
        features: realTrees.map((t) => ({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [parseFloat(t.lon), parseFloat(t.lat)],
          },
          properties: { tree_id: t.tree_id, name: t.nickname || t.name },
        })),
      },
      stations: {
        type: "FeatureCollection",
        features: stationList.map((s) => ({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [parseFloat(s.lon), parseFloat(s.lat)],
          },
          properties: { name: s.station_name, source_id: s.id },
        })),
      },
      customStations: {
        type: "FeatureCollection",
        features: customRaw
          .filter((s) => s.is_active)
          .map((s) => ({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [parseFloat(s.lon), parseFloat(s.lat)],
            },
            properties: { name: s.name, station_id: s.id },
          })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 2: Tree Detail (Synop IDW Interpolation with Distance Filter & Time Sort)
app.get("/api/details/:treeId", async (req, res) => {
  try {
    const token = await getAuthToken();
    const treeId = req.params.treeId;
    const userRadiusMeters = req.query.radius || 100000;
    const userRadiusKm = userRadiusMeters / 1000;

    const metaRes = await fetch(`${FAST_API_URL}/v1/trees?tree_id=${treeId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const tree = (await metaRes.json())[0];

    const [sRes, sourcesRes, synopRes] = await Promise.all([
      fetch(`${FAST_API_URL}/v1/sensors?tree_id=${treeId}&from_time=now-48h`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(
        `${FAST_API_URL}/v1/dwd-sources?lat=${tree.lat}&lon=${tree.lon}&max_dist=${userRadiusMeters}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      fetch(
        `${FAST_API_URL}/v1/dwd-synop?lat=${tree.lat}&lon=${tree.lon}&max_dist=${userRadiusMeters}&from_time=now-24h&tz=Europe/Berlin`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ]);

    const stationMetadata = (await sourcesRes.json()).sources || [];
    const synopRaw = await synopRes.json();
    const allObservations = synopRaw.weather || [];
    const sensorData = await sRes.json();

    let totalWeight = 0,
      weightedTemp = 0,
      weightedHum = 0,
      stationsUsedCount = 0;

    const pastObservations = allObservations
      .filter((obs) => new Date(obs.timestamp) <= new Date())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const latestPerStation = [];
    pastObservations.forEach((obs) => {
      if (!latestPerStation.find((x) => x.source_id === obs.source_id)) {
        latestPerStation.push(obs);
      }
    });

    latestPerStation.forEach((obs) => {
      const meta = stationMetadata.find((s) => s.id === obs.source_id);
      if (meta && obs.temperature !== null) {
        const dist = getDistance(tree.lat, tree.lon, meta.lat, meta.lon);

        if (dist <= userRadiusKm) {
          const weight = 1 / Math.pow(Math.max(dist, 0.1), 2);
          weightedTemp += obs.temperature * weight;
          weightedHum += obs.relative_humidity * weight;
          totalWeight += weight;
          stationsUsedCount++;
        }
      }
    });

    const latestSensor = Array.isArray(sensorData)
      ? sensorData.find((d) => typeof d.cli_temperature === "number")
      : {};

    res.json({
      name: tree.nickname || tree.name,
      sensor: latestSensor,
      dwd: {
        temp:
          totalWeight > 0
            ? parseFloat((weightedTemp / totalWeight).toFixed(2))
            : null,
        humidity:
          totalWeight > 0
            ? parseFloat((weightedHum / totalWeight).toFixed(1))
            : null,
        method: `IDW (${userRadiusKm}km Radius | ${stationsUsedCount} Synop Stations)`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 3: Unique Station Popup (Synop Hardware)
app.get("/api/dwd-live/:sourceId", async (req, res) => {
  try {
    const token = await getAuthToken();
    const url = `${FAST_API_URL}/v1/dwd-synop?source_id=${req.params.sourceId}&from_time=now-24h&tz=Europe/Berlin&_cb=${Date.now()}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();

    const observations = (data.weather || []).filter(
      (o) => new Date(o.timestamp) <= new Date(),
    );
    const latest =
      observations.length > 0 ? observations[observations.length - 1] : {};

    res.json({
      temp: latest.temperature ?? "N/A",
      humidity:
        latest.relative_humidity !== null &&
        latest.relative_humidity !== undefined
          ? latest.relative_humidity
          : "N/A",
      time: latest.timestamp || "N/A",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 4: Internal Hardware Live Telemetry Parser
app.get("/api/custom-live/:stationId", async (req, res) => {
  try {
    const token = await getAuthToken();
    const stationId = req.params.stationId;
    const url = `${FAST_API_URL}/v1/weather-data?weather_id=weather-001&weather_id=weather-002&from_time=now-7d&to_time=now`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();

    // Ensure safe array navigation loops fallback smoothly
    const observations = Array.isArray(data) ? data : [];

    // Chronological JavaScript ascending sort block comparison evaluation math
    const stationData = observations
      .filter(
        (obs) =>
          obs.weather_id === stationId && new Date(obs.time_at) <= new Date(),
      )
      .sort((a, b) => new Date(a.time_at) - new Date(b.time_at));

    // Pull the absolute latest valid past record index row entry safely
    const latest =
      stationData.length > 0 ? stationData[stationData.length - 1] : {};

    res.json({
      temp: latest.air_temperature ?? "N/A",
      humidity: latest.air_humidity ?? "N/A",
      time: latest.time_at || "N/A",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () =>
  console.log(`🚀 Smart City Server: http://localhost:${port}`),
);
