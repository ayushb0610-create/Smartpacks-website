const $ = s => document.querySelector(s);

/* ---------- backend wiring ----------
   The frontend still works completely standalone (its own local arrays +
   local scoring engine, below) if no backend is reachable — that's the
   fallback path. When a backend IS reachable, it takes over: dropdowns and
   tables load from Postgres via the API, recommendations are scored
   server-side (with an ML-predicted shelf life alongside the deterministic
   one), and history comes from `recommendation_runs` instead of
   localStorage. Override window.SMARTPACK_API_BASE before this script runs
   to point at a non-default API host. */
const API_BASE = (window.SMARTPACK_API_BASE || "http://localhost:4000/api").replace(/\/$/, "");
let backendOnline = false;

async function checkBackend() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${API_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    backendOnline = res.ok;
  } catch (e) {
    backendOnline = false;
  }
  return backendOnline;
}

// Postgres rows are snake_case with slightly different names/shapes than
// the original hardcoded arrays; these adapters let every existing render/
// table function below keep working unchanged regardless of data source.
function mapBackendCommodity(r) {
  return {
    id: r.id, name: r.name, category: r.category,
    moisture: +r.moisture_pct, fat: +r.fat_pct, ph: r.ph == null ? null : +r.ph,
    aw: +r.water_activity, resp: +r.respiration_rate,
    o2: r.o2_target_pct == null ? null : +r.o2_target_pct,
    co2: r.co2_target_pct == null ? null : +r.co2_target_pct,
    base_life: +r.base_shelf_life_days, source: r.source,
    usda: r.usda_temp_note ? { temp: r.usda_temp_note, rh: r.usda_rh_note, life: r.usda_life_note } : null,
  };
}
function mapBackendMaterial(r) {
  return {
    id: r.id, name: r.name, otr: +r.otr, wvtr: +r.wvtr, thickness: +r.thickness_um,
    cost: +r.cost_index, sustain: +r.sustainability, strength: +r.strength, seal: +r.sealability,
    light: +r.light_barrier, tmin: +r.temp_min_c, tmax: +r.temp_max_c,
    recyclable: r.recyclable, note: r.note, source: r.source,
  };
}
function mapBackendCity(r) {
  return { state: r.state, city: r.city, lat: +r.lat, lon: +r.lon, t: +r.peak_temp_c, rh: +r.peak_rh_pct, note: r.climate_note };
}

/* ---------- data ---------- */
// name, category, moisture%, fat%, pH, resp mLCO2/kg.h@10C, optimum O2%, optimum CO2%, base shelf life days@25C, source
const COMMODITIES = [
  {name:"Tomato", category:"produce", moisture:94, fat:0.2, ph:4.4, aw:0.99, resp:7.9, o2:3, co2:2, base_life:5,
    source:"USDA AH-66", usda:{temp:"13–21 °C to ripen; red fruit 7–13 °C briefly (chilling injury below 13 °C)", rh:"90–95%", life:"days once red; weeks green",
      curve:[[10,7.9],[15,11.9],[20,19.4],[25,24.6]]}},
  {name:"Banana", category:"produce", moisture:75, fat:0.3, ph:5.0, aw:0.98, resp:42.1, o2:4, co2:5, base_life:6,
    source:"USDA AH-66", usda:{temp:"13–14 °C (green; chilling-sensitive below 13 °C)", rh:"90–95%", life:"7–28 days green, variety dependent",
      curve:[[10,42.1],[15,75.7],[20,155.6]]}},
  {name:"Spinach", category:"produce", moisture:91, fat:0.4, ph:6.5, aw:0.99, resp:57.9, o2:8, co2:8, base_life:2,
    source:"USDA AH-66", usda:{temp:"0 °C", rh:"95–98%", life:"~2 weeks",
      curve:[[0,10.5],[5,23.1],[10,57.9],[15,96.8],[20,127.8]]}},
  {name:"Strawberry", category:"produce", moisture:90, fat:0.3, ph:3.5, aw:0.98, resp:39.5, o2:10, co2:15, base_life:2,
    source:"USDA AH-66", usda:{temp:"0 °C", rh:"90–95%", life:"up to 7 days",
      curve:[[0,8],[10,39.5],[20,83.3]]}},
  {name:"Apple", category:"produce", moisture:86, fat:0.2, ph:3.5, aw:0.97, resp:4.7, o2:3, co2:2.5, base_life:20,
    source:"USDA AH-66", usda:{temp:"−1 to 4 °C", rh:"90–95%", life:"3–8 months air storage (longer under CA)",
      curve:[[0,1.5],[5,3.1],[10,4.7],[15,8.1],[20,11.1]]}},
  {name:"Potato", category:"produce", moisture:79, fat:0.1, ph:6.0, aw:0.98, resp:8.4, o2:5, co2:3, base_life:30,
    source:"USDA AH-66", usda:{temp:"7–10 °C fresh market (cured stock at 4–10 °C)", rh:"95–99%", life:"2–12 months cured",
      curve:[[5,6.2],[10,8.4],[15,9.2],[20,12.2]]}},
  {name:"Potato chips", category:"snack", moisture:2, fat:35, ph:6.0, aw:0.15, resp:0, o2:0, co2:0, base_life:90, source:"Estimate (author)"},
  {name:"Biscuits", category:"bakery", moisture:4, fat:20, ph:6.5, aw:0.25, resp:0, o2:0, co2:0, base_life:120, source:"Estimate (author)"},
  {name:"Bread", category:"bakery", moisture:35, fat:3, ph:5.5, aw:0.96, resp:0, o2:0, co2:0, base_life:4, source:"Estimate (author)"},
  {name:"Milk powder", category:"dairy", moisture:3.5, fat:26, ph:6.6, aw:0.20, resp:0, o2:0, co2:0, base_life:180, source:"Estimate (author)"},
  {name:"Cheese", category:"dairy", moisture:40, fat:30, ph:5.3, aw:0.95, resp:0, o2:0, co2:0, base_life:30, source:"Estimate (author)"},
  {name:"Fresh chicken", category:"meat", moisture:70, fat:5, ph:6.2, aw:0.99, resp:0, o2:0, co2:0, base_life:1.5, source:"Estimate (author)"},
  {name:"Frozen green peas", category:"frozen", moisture:79, fat:0.4, ph:6.5, aw:0.98, resp:0, o2:0, co2:0, base_life:3, source:"Estimate (author)"},
  {name:"Chilli powder", category:"spice", moisture:8, fat:10, ph:5.5, aw:0.45, resp:0, o2:0, co2:0, base_life:120, source:"Estimate (author)"},
];

// name, OTR cc/m2/day, WVTR g/m2/day, thickness um, cost 1-5, sustain 1-10, strength 1-10, seal 1-10, tmin, tmax, recyclable, note
const MATERIALS = [
  {name:"LDPE", otr:6500, wvtr:18, thickness:50, cost:1, sustain:5, strength:5, seal:9, light:3, tmin:-50, tmax:80, recyclable:"Yes (#4)", note:"Cheap, heat-sealable, high gas permeability", source:"Estimate (author)"},
  {name:"HDPE", otr:1800, wvtr:7, thickness:40, cost:1.2, sustain:6, strength:6, seal:8, light:5, tmin:-50, tmax:100, recyclable:"Yes (#2)", note:"Stiffer, better moisture barrier than LDPE", source:"Estimate (author)"},
  {name:"BOPP", otr:1500, wvtr:6, thickness:30, cost:1.5, sustain:6, strength:7, seal:7, light:2, tmin:-20, tmax:100, recyclable:"Yes (#5)", note:"Clear, good moisture barrier, printable", source:"Estimate (author)"},
  {name:"PET", otr:100, wvtr:40, thickness:12, cost:2, sustain:6, strength:9, seal:3, light:2, tmin:-40, tmax:150, recyclable:"Yes (#1)", note:"Strong, good gas barrier; needs a sealant layer", source:"Estimate (author)"},
  {name:"PET/LDPE laminate", otr:90, wvtr:15, thickness:62, cost:2.5, sustain:4, strength:8, seal:9, light:2, tmin:-40, tmax:80, recyclable:"Limited", note:"Sealable barrier laminate", source:"Estimate (author)"},
  {name:"Metallized PET/PE", otr:0.77, wvtr:1, thickness:60, cost:3, sustain:3, strength:8, seal:9, light:9, tmin:-40, tmax:80, recyclable:"No", note:"High barrier for snacks, powders, coffee", source:"Piergiovanni & Limbo 2016, Table 6.3 (29 nm Al on 25 µm PET)"},
  {name:"Aluminium foil laminate", otr:0.05, wvtr:0.05, thickness:80, cost:4.5, sustain:2, strength:7, seal:8, light:10, tmin:-40, tmax:120, recyclable:"No", note:"Absolute barrier, retort/long shelf life", source:"Estimate (author)"},
  {name:"EVOH coextrusion", otr:3, wvtr:8, thickness:70, cost:3.5, sustain:4, strength:8, seal:9, light:3, tmin:-40, tmax:80, recyclable:"Limited", note:"Excellent O2 barrier for MAP meat and cheese", source:"Estimate (author)"},
  {name:"PLA (biodegradable)", otr:800, wvtr:100, thickness:30, cost:3, sustain:8, strength:5, seal:6, light:2, tmin:-10, tmax:50, recyclable:"Compostable", note:"Bio-based; poor heat resistance and moisture barrier", source:"Estimate (author)"},
  {name:"Micro-perforated BOPP", otr:12000, wvtr:30, thickness:30, cost:2, sustain:5, strength:7, seal:7, light:2, tmin:-20, tmax:80, recyclable:"Yes (#5)", note:"Breathable; perforation count tunes OTR for produce", source:"Estimate (author)"},
  {name:"Cast PP (CPP)", otr:1800, wvtr:6, thickness:35, cost:1.4, sustain:5, strength:6, seal:9, light:2, tmin:-20, tmax:120, recyclable:"Yes (#5)", note:"Common heat-seal layer in laminates; good clarity", source:"Estimate (author)"},
  {name:"Rigid PVC", otr:250, wvtr:25, thickness:300, cost:2, sustain:3, strength:7, seal:4, light:3, tmin:-10, tmax:60, recyclable:"Yes (#3)", note:"Clear rigid trays and blisters; moderate O2 barrier", source:"Estimate (author)"},
  {name:"PVDC-coated film", otr:15, wvtr:3, thickness:30, cost:2.8, sustain:3, strength:6, seal:7, light:3, tmin:-20, tmax:90, recyclable:"No", note:"High-barrier coating on OPP/PA; chlorine content limits recycling", source:"Estimate (author)"},
  {name:"Polystyrene (GPPS)", otr:5000, wvtr:120, thickness:500, cost:1.5, sustain:4, strength:4, seal:3, light:3, tmin:-20, tmax:70, recyclable:"Yes (#6)", note:"Clear rigid cups and trays; brittle", source:"Estimate (author)"},
  {name:"Expanded polystyrene (EPS)", otr:20000, wvtr:150, thickness:2000, cost:1, sustain:2, strength:3, seal:2, light:7, tmin:-40, tmax:80, recyclable:"Limited", note:"Insulating produce/meat trays; bulky to recycle", source:"Estimate (author)"},
  {name:"Biaxially oriented nylon (BOPA)", otr:40, wvtr:250, thickness:15, cost:3, sustain:5, strength:9, seal:4, light:2, tmin:-60, tmax:150, recyclable:"Limited", note:"Excellent puncture and O2 barrier; poor moisture barrier alone", source:"Estimate (author)"},
  {name:"PA/PE laminate", otr:40, wvtr:15, thickness:70, cost:3, sustain:4, strength:8, seal:9, light:3, tmin:-40, tmax:90, recyclable:"Limited", note:"Vacuum meat/cheese packs; nylon strength with PE seal layer", source:"Estimate (author)"},
  {name:"Ionomer (Surlyn-type)", otr:3000, wvtr:15, thickness:50, cost:3.2, sustain:4, strength:7, seal:10, light:2, tmin:-70, tmax:90, recyclable:"Limited", note:"Outstanding hot-tack seal; usually the innermost sealant layer", source:"Estimate (author)"},
  {name:"Cellophane (uncoated)", otr:10, wvtr:600, thickness:30, cost:2, sustain:8, strength:5, seal:2, light:1, tmin:-20, tmax:150, recyclable:"Compostable", note:"Regenerated cellulose; biodegradable but very poor moisture barrier", source:"Estimate (author)"},
  {name:"Glassine paper", otr:2000, wvtr:250, thickness:40, cost:1.5, sustain:7, strength:3, seal:1, light:5, tmin:-20, tmax:150, recyclable:"Yes (paper)", note:"Greaseproof paper for bakery and confectionery wraps", source:"Estimate (author)"},
  {name:"Kraft paper", otr:15000, wvtr:1000, thickness:80, cost:1, sustain:8, strength:4, seal:1, light:8, tmin:-20, tmax:150, recyclable:"Yes (paper)", note:"Cheap and breathable; essentially no gas or moisture barrier alone", source:"Estimate (author)"},
  {name:"Wax-coated paper", otr:3000, wvtr:15, thickness:60, cost:1.4, sustain:6, strength:3, seal:4, light:6, tmin:-10, tmax:40, recyclable:"Limited", note:"Traditional produce wrap; coating softens above ~40 °C", source:"Estimate (author)"},
  {name:"LDPE-coated paperboard", otr:5000, wvtr:10, thickness:350, cost:2, sustain:6, strength:7, seal:8, light:8, tmin:-20, tmax:80, recyclable:"Limited", note:"Liquid cartons: paperboard stiffness with a PE liquid barrier", source:"Estimate (author)"},
  {name:"Corrugated fibreboard", otr:30000, wvtr:2000, thickness:3000, cost:1.2, sustain:9, strength:9, seal:1, light:9, tmin:-30, tmax:60, recyclable:"Yes (paper)", note:"Outer shipping case; not a barrier layer on its own", source:"Estimate (author)"},
  {name:"HDPE woven sack (raffia)", otr:20000, wvtr:50, thickness:200, cost:1, sustain:5, strength:8, seal:3, light:6, tmin:-30, tmax:80, recyclable:"Yes (#2)", note:"Bulk grain/sugar sacks; needs a PE liner for any real barrier", source:"Estimate (author)"},
  {name:"LDPE-coated jute bag", otr:25000, wvtr:40, thickness:500, cost:1.3, sustain:9, strength:7, seal:2, light:7, tmin:-20, tmax:80, recyclable:"Limited", note:"Natural-fibre sack with a thin PE moisture liner", source:"Estimate (author)"},
  {name:"PET bottle (blow-moulded)", otr:20, wvtr:2, thickness:300, cost:2.2, sustain:6, strength:9, seal:5, light:2, tmin:-20, tmax:60, recyclable:"Yes (#1)", note:"Water and carbonated drinks; barrier scales with wall thickness, needs a closure", source:"Estimate (author)"},
  {name:"HDPE bottle", otr:50, wvtr:1, thickness:500, cost:1.8, sustain:6, strength:8, seal:5, light:6, tmin:-40, tmax:80, recyclable:"Yes (#2)", note:"Milk jugs and similar rigid bottles", source:"Estimate (author)"},
  {name:"Retort pouch (PET/Al/CPP)", otr:0.05, wvtr:0.1, thickness:100, cost:4, sustain:2, strength:9, seal:9, light:10, tmin:-40, tmax:135, recyclable:"No", note:"Withstands retort sterilisation (~121 °C); shelf-stable ready meals", source:"Estimate (author)"},
  {name:"Aseptic carton (paper/Al/PE)", otr:0.5, wvtr:0.3, thickness:380, cost:3.5, sustain:6, strength:8, seal:8, light:9, tmin:-20, tmax:60, recyclable:"Limited", note:"Long-life liquid cartons; mostly paper by weight (Tetra Pak-style)", source:"Estimate (author)"},
  {name:"Tinplate can", otr:0.01, wvtr:0.01, thickness:200, cost:3.5, sustain:6, strength:10, seal:10, light:10, tmin:-40, tmax:180, recyclable:"Yes (steel)", note:"Near-absolute barrier, retort-stable canning material", source:"Estimate (author)"},
  {name:"Aluminium can/tray", otr:0, wvtr:0, thickness:150, cost:3.8, sustain:5, strength:9, seal:8, light:10, tmin:-40, tmax:200, recyclable:"Yes (aluminium)", note:"Infinitely recyclable, absolute barrier", source:"Estimate (author)"},
  {name:"Glass container", otr:0, wvtr:0, thickness:2500, cost:2.5, sustain:7, strength:9, seal:9, light:2, tmin:-40, tmax:300, recyclable:"Yes (glass)", note:"Inert and infinitely recyclable; heavy and fragile", source:"Estimate (author)"},
  {name:"PHA/PHB bioplastic", otr:15, wvtr:20, thickness:40, cost:4.5, sustain:9, strength:6, seal:6, light:3, tmin:-10, tmax:60, recyclable:"Compostable", note:"Marine-degradable bioplastic, PP-like barrier, still costly", source:"Estimate (author)"},
  {name:"Starch-blend bioplastic", otr:500, wvtr:150, thickness:30, cost:3, sustain:8, strength:4, seal:6, light:4, tmin:-10, tmax:45, recyclable:"Compostable", note:"Home-compostable carrier bags; weak moisture barrier", source:"Estimate (author)"},
  {name:"Shrink film (PVC/POF)", otr:2000, wvtr:15, thickness:20, cost:1.6, sustain:4, strength:5, seal:6, light:2, tmin:-10, tmax:70, recyclable:"Limited", note:"Bundling/overwrap; not a primary barrier layer", source:"Estimate (author)"},
  {name:"Skin-pack film (EVA/ionomer)", otr:800, wvtr:20, thickness:40, cost:2.5, sustain:4, strength:6, seal:9, light:2, tmin:-20, tmax:80, recyclable:"Limited", note:"Vacuum skin packaging conforms tightly to product surface", source:"Estimate (author)"},
  {name:"Medium-density PE (MDPE)", otr:4000, wvtr:10, thickness:45, cost:1.1, sustain:5, strength:6, seal:8, light:3, tmin:-40, tmax:90, recyclable:"Yes (#4)", note:"Carrier bags; stiffer than LDPE, more flexible than HDPE", source:"Estimate (author)"},
];

// state, city, lat, lon, typical peak ambient temp °C, typical RH % (worst-case transit season), one-line climate note
const INDIA_CITIES = [
  {state:"Maharashtra", city:"Mumbai", lat:19.076, lon:72.877, t:33, rh:80, note:"Coastal, hot & humid"},
  {state:"Maharashtra", city:"Pune", lat:18.520, lon:73.856, t:32, rh:55, note:"Moderate, drier inland"},
  {state:"Delhi", city:"New Delhi", lat:28.613, lon:77.209, t:42, rh:30, note:"Hot & dry summers"},
  {state:"West Bengal", city:"Kolkata", lat:22.572, lon:88.363, t:35, rh:85, note:"Hot & very humid"},
  {state:"Tamil Nadu", city:"Chennai", lat:13.082, lon:80.270, t:38, rh:75, note:"Coastal, hot & humid"},
  {state:"Karnataka", city:"Bengaluru", lat:12.971, lon:77.594, t:30, rh:60, note:"Mild, moderate humidity"},
  {state:"Telangana", city:"Hyderabad", lat:17.385, lon:78.486, t:38, rh:50, note:"Hot, semi-arid"},
  {state:"Gujarat", city:"Ahmedabad", lat:23.022, lon:72.571, t:42, rh:40, note:"Hot & dry"},
  {state:"Rajasthan", city:"Jaipur", lat:26.912, lon:75.787, t:42, rh:30, note:"Desert, hot & very dry"},
  {state:"Punjab", city:"Amritsar", lat:31.634, lon:74.872, t:40, rh:45, note:"Hot summer, cold winter"},
  {state:"Uttar Pradesh", city:"Lucknow", lat:26.847, lon:80.947, t:40, rh:40, note:"Hot & dry summer"},
  {state:"Kerala", city:"Kochi", lat:9.931, lon:76.267, t:32, rh:85, note:"Tropical, very humid"},
  {state:"Assam", city:"Guwahati", lat:26.144, lon:91.736, t:33, rh:85, note:"Humid, high rainfall"},
  {state:"Jammu & Kashmir", city:"Srinagar", lat:34.083, lon:74.797, t:30, rh:50, note:"Cool mountain climate"},
  {state:"Himachal Pradesh", city:"Shimla", lat:31.104, lon:77.173, t:25, rh:55, note:"Cool hill climate"},
  {state:"Madhya Pradesh", city:"Bhopal", lat:23.259, lon:77.412, t:40, rh:45, note:"Hot, central India"},
  {state:"Bihar", city:"Patna", lat:25.594, lon:85.137, t:40, rh:70, note:"Hot & humid"},
  {state:"Odisha", city:"Bhubaneswar", lat:20.296, lon:85.824, t:38, rh:80, note:"Coastal, hot & humid"},
  {state:"Andhra Pradesh", city:"Visakhapatnam", lat:17.686, lon:83.218, t:35, rh:75, note:"Coastal, hot & humid"},
  {state:"Goa", city:"Panaji", lat:15.490, lon:73.827, t:32, rh:85, note:"Coastal, very humid"},
];
function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon/2)**2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(h)));
}

const FOOD_EMOJI = {
  "Tomato":"🍅","Banana":"🍌","Spinach":"🥬","Strawberry":"🍓","Apple":"🍎","Potato":"🥔",
  "Potato chips":"🍟","Biscuits":"🍪","Bread":"🍞","Milk powder":"🥛","Cheese":"🧀",
  "Fresh chicken":"🍗","Frozen green peas":"🫛","Chilli powder":"🌶️"
};
const foodIcon = name => FOOD_EMOJI[name] || "🍽️";
const foodLabel = name => `${foodIcon(name)} ${name}`;

let history = [];
try { history = JSON.parse(localStorage.getItem("sp_history") || "[]"); } catch (e) { history = []; }
const saveHistory = () => { try { localStorage.setItem("sp_history", JSON.stringify(history)); } catch (e) {} };

// Piergiovanni & Limbo, Food Packaging Materials (Springer, 2016) — Table 6.1 (coextrusion) & 6.2 (lamination)
const MULTILAYERS = [
  {structure:"HIPS/adhesive/PVDC/HIPS", process:"Coextrusion", application:"Thermoforming films & sheets"},
  {structure:"PP/adhesive/EVOH/adhesive/HDPE", process:"Coextrusion", application:"Retortable semi-rigid films & sheets"},
  {structure:"Virgin PET/recycled PET/virgin PET", process:"Coextrusion", application:"Thermoforming films & sheets"},
  {structure:"PA/adhesive/LDPE", process:"Coextrusion", application:"Flexible film"},
  {structure:"LDPE/EVOH/LDPE", process:"Coextrusion", application:"Flexible film"},
  {structure:"LDPE/PA/tie/EVOH/tie/PA/LDPE", process:"Coextrusion", application:"Film, thermoforming sheets"},
  {structure:"PE/adhesive/EVOH/adhesive/HIPS", process:"Coextrusion", application:"Thermoforming films & sheets"},
  {structure:"OPP/adhesive/EVA", process:"Lamination", application:"Flexible film"},
  {structure:"OPP/coextruded PP", process:"Lamination", application:"Flexible film"},
  {structure:"OPP/adhesive/OPP/PVDC", process:"Lamination", application:"Flexible film"},
  {structure:"Cellophane/adhesive/LDPE", process:"Lamination", application:"Peelable 'snap open' closure"},
  {structure:"PET/Aluminium/peelable polymer blend", process:"Lamination", application:"Flexible film"},
  {structure:"Metallised PA/LDPE/EVA", process:"Lamination", application:"Flexible film"},
  {structure:"PA/adhesive/EVA", process:"Lamination", application:"Flexible film"},
  {structure:"OPP/PVDC/ionomers", process:"Lamination", application:"Flexible film"},
  {structure:"Paper/LDPE", process:"Lamination", application:"Semi-rigid material"},
  {structure:"PE/ink/board/PE/aluminium foil/tie or primer/PE", process:"Lamination", application:"Aseptic beverage carton"},
];
// Table 6.3 — O2 permeability of a 25 µm PET film as metal (aluminium) layer thickens
const METALLIZATION = [
  {metal_nm:0, po2:45}, {metal_nm:12, po2:1.55}, {metal_nm:29, po2:0.77}, {metal_nm:36, po2:0.62}, {metal_nm:39, po2:0.26},
];
// BIS IS 10106 (Appendix Table 1) & IS 10171-1982 (Appendix Table 2) — recommended packaging by product,
// matched to SmartPack's commodity list.
const BIS_PACKAGING = [
  {commodity:"Tomato", materials:"Baskets or wooden/corrugated boxes (fresh); glass or PET containers for ketchup/juice", standard:"Table 1 VIII.1.b, 5.a-b"},
  {commodity:"Banana", materials:"Wooden/plastic crates, lined or unlined corrugated boxes; LDPE/PP/HDPE bags, perforated or plain", standard:"Table 1 VIII.1; Table 2, Fresh fruits & vegetables"},
  {commodity:"Spinach", materials:"Loosely woven gunny bags or crates; LDPE/PP/HDPE bags, perforated or plain", standard:"Table 1 VIII.1; Table 2, Fresh fruits & vegetables"},
  {commodity:"Strawberry", materials:"Lined/unlined corrugated boxes; individually wrapped in tissue paper for delicate fruit", standard:"Table 1 VIII.1.e (by analogy); Table 2, Fresh fruits"},
  {commodity:"Apple", materials:"Wooden or lined corrugated boxes; individually wrapped in tissue paper", standard:"Table 1 VIII.1.e"},
  {commodity:"Potato", materials:"Loosely woven gunny bags; wooden or plastic crates; lined/unlined corrugated boxes", standard:"Table 1 VIII.1"},
  {commodity:"Potato chips", materials:"LDPE/HDPE bags, laminated to cellophane, BOPP or polyester", standard:"Table 2, Dried snacks"},
  {commodity:"Biscuits", materials:"Tinplate or PCRC/cardboard containers; Cello/LDPE, BOPP/LDPE, PET/LDPE, Paper/LDPE or Foil/LDPE wrappers", standard:"Table 1 V.2; Table 2, Biscuits"},
  {commodity:"Bread", materials:"LDPE-coated poster paper or waxed paper (sliced loaves); grease-proof paper", standard:"Table 1 V.1; Table 2, Bread"},
  {commodity:"Milk powder", materials:"Hermetically sealed tinplate containers; bag-in-box of PET/LDPE or BONF/LDPE (foil essential)", standard:"Table 1 I.10; Table 2, Whole/skimmed milk powder"},
  {commodity:"Cheese", materials:"BONF/EVA, BONF/ionomer or BOPP/EVA laminates; lacquered metal cans", standard:"Table 1 I.5; Table 2, Hard & processed cheese"},
  {commodity:"Fresh chicken", materials:"Polyethylene bags (~50 µm); shrinkable PVDC/LDPE/PP bags", standard:"Table 1 XI.2.d1; Table 2, Dressed poultry"},
  {commodity:"Frozen green peas", materials:"Tinplate or laminated foil containers; metallised BOPP/LDPE or LDPE/HDPE bags", standard:"Table 1 VIII.3; Table 2, Frozen fruits & vegetables"},
  {commodity:"Chilli powder", materials:"Paper bags; PET/LDPE, PET/EVA or BOPP/EVA pouches", standard:"Table 1 VII.2, 3.d; Table 2, Curry/ground spice powders"},
];



/* ---------- appearance ---------- */
$("#themeToggle").onclick = () => {
  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") === "dark";
  root.setAttribute("data-theme", dark ? "light" : "dark");
  document.body.style.filter = "brightness(.999)";
};

/* ---------- tabs ---------- */
function moveIndicator(t) {
  const nav = $("#tabnav"), r = t.getBoundingClientRect(), nr = nav.getBoundingClientRect();
  $("#tabInd").style.left = (r.left - nr.left + nav.scrollLeft) + "px";
  $("#tabInd").style.width = r.width + "px";
}
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab,.pane").forEach(e => e.classList.remove("on"));
  t.classList.add("on"); $("#" + t.dataset.tab).classList.add("on");
  moveIndicator(t);
  if (t.dataset.tab === "his") loadHistory();
  if (t.dataset.tab === "ref") { loadMultilayers(); loadMetallization(); loadBIS(); }
});
window.addEventListener("resize", () => moveIndicator(document.querySelector(".tab.on")));

/* ---------- sliders ---------- */
const sliders = { temp: v => v + " °C", rh: v => v + " %", life: v => v + " days", aw: v => (+v).toFixed(2) + " aw", oxSens: v => v + " / 5", lightSens: v => v + " / 5" };
for (const id in sliders) {
  const upd = () => $("#" + id + "Out").textContent = sliders[id]($("#" + id).value);
  $("#" + id).oninput = upd; upd();
}
const TEMPS = { ambient: 25, chilled: 4, frozen: -18 };

// Typical defaults for aw / oxidation sensitivity / light sensitivity,
// scaled by the *currently selected storage type* on top of the commodity's
// own data. Re-run whenever the commodity changes OR the user manually
// switches storage type, so the sliders always reflect the active combo.
function scaleSensitivities() {
  const c = COMMODITIES.find(x => x.name === $("#commodity").value);
  if (!c) return;
  const fresh = c.resp > 0;
  const storageType = $("#storage").value;

  // Water activity is intrinsic to the food, but frozen storage locks most
  // of that water as ice — the water still driving spoilage/migration risk
  // is effectively far lower, so cap it for frozen items.
  const awTypical = storageType === "frozen" ? Math.min(c.aw, 0.3) : c.aw;
  $("#aw").value = awTypical.toFixed(2); $("#aw").oninput();

  // Oxidation sensitivity: fat content sets the baseline risk; lower
  // storage temperature slows lipid oxidation (roughly Q10 ≈ 2–3 per 10°C),
  // so scale the typical value down for chilled/frozen.
  const oxBase = c.fat >= 15 ? 4 : c.fat >= 5 ? 3 : 2;
  const oxScale = storageType === "frozen" ? 0.5 : storageType === "chilled" ? 0.75 : 1;
  $("#oxSens").value = Math.max(1, Math.round(oxBase * oxScale)); $("#oxSens").oninput();

  // Light sensitivity is mostly a property of the commodity itself (fresh
  // produce vs. fatty packaged goods), largely independent of temperature —
  // but frozen goods are almost always sold in opaque/foil packs already,
  // so nudge the typical exposure risk down slightly for frozen.
  const lightBase = fresh ? 3 : (c.fat >= 15 ? 3 : 1);
  $("#lightSens").value = storageType === "frozen" ? Math.max(1, lightBase - 1) : lightBase;
  $("#lightSens").oninput();
}
$("#storage").onchange = () => { $("#temp").value = TEMPS[$("#storage").value]; $("#temp").oninput(); scaleSensitivities(); };

/* ---------- commodity autofill ---------- */
function fill() {
  const c = COMMODITIES.find(x => x.name === $("#commodity").value);
  ["moisture", "fat", "ph", "resp"].forEach(k => $("#" + k).value = c[k]);
  const fresh = c.resp > 0, frozen = c.category === "frozen";
  $("#storage").value = frozen ? "frozen" : fresh || c.category === "meat" ? "chilled" : "ambient";
  $("#storage").onchange(); // sets temp AND runs scaleSensitivities() for the new storage type
  $("#life").value = frozen ? 180 : fresh ? 10 : c.category === "meat" ? 7 : Math.min(c.base_life, 180);
  $("#life").oninput();
}
$("#commodity").onchange = fill;

/* ---------- engine ----------
   Produce OTR target = respiration rate (interpolated from measured USDA
   points, or Q10≈2.5 scaling of the single estimate) × pack weight ÷
   (film area × O2 driving force). Film area is approximated from pack
   weight assuming a roughly cubic pack of density 0.5 kg/L for produce.
   Non-produce items instead get a MAX allowed OTR/WVTR, derived from fat
   (oxidation risk) and moisture (drying/staling risk). */
function respAt(c, T) {
  if (c.usda && c.usda.curve.length > 1) {
    const pts = c.usda.curve;
    if (T <= pts[0][0]) return pts[0][1];
    if (T >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, r0] = pts[i], [t1, r1] = pts[i + 1];
      if (T >= t0 && T <= t1) return r0 + (r1 - r0) * (T - t0) / (t1 - t0);
    }
  }
  return c.resp * Math.pow(2.5, (T - 10) / 10);
}
function required(c, T, weightG, lifeDays, rh, aw, oxSens) {
  const weightKg = weightG / 1000;
  const areaM2 = 0.15 * Math.pow(Math.max(weightKg, 0.01), 2 / 3); // rough cubic-pack estimate

  // Moisture-gradient factor: the bigger the gap between the product's own water
  // activity and the storage RH, the faster moisture migrates either way, so the
  // allowed WVTR tightens as the gap widens and relaxes as it narrows (ref. gap 50 pts).
  const rhGap = Math.max(Math.abs(aw * 100 - rh), 5);
  const moistureFactor = 50 / rhGap;

  if (c.resp > 0) {
    const rate = respAt(c, T);                       // mL O2/kg.h (≈ mL CO2, RQ~1)
    const dailyMl = rate * weightKg * 24;
    const drivingForce = Math.max(0.21 - c.o2 / 100, 0.03);
    const otr = dailyMl / (areaM2 * drivingForce);
    const wLossBudget = 0.05 * weightG;               // 5% weight-loss ceiling
    const wvtr = (wLossBudget / (areaM2 * Math.max(lifeDays, 1))) * moistureFactor;
    return { otr, wvtr, produce: true, gas: `O₂ ${c.o2}% · CO₂ ${c.co2}% · bal. N₂`, areaM2 };
  }
  // Oxidation sensitivity (1 typical, 5 highly sensitive) tightens the ceiling around
  // the fat-driven baseline instead of only estimating it from fat content alone.
  const oxFactor = Math.max(oxSens, 0.5) / 3;
  const otrMax = (60 / (1 + c.fat * 1.2)) / oxFactor;
  const wvtrBase = c.moisture < 10 ? 3 + c.moisture : 25 * (c.moisture / 100);
  const wvtrMax = wvtrBase * moistureFactor;
  return { otr: otrMax, wvtr: wvtrMax, produce: false, gas: "N/A — flush with N₂ or vacuum-seal", areaM2 };
}
const WEIGHTS = {
  balanced: { barrier: .4, cost: .15, sustain: .15, strength: .15, seal: .15 },
  cost:     { barrier: .3, cost: .4,  sustain: .1,  strength: .1,  seal: .1  },
  sustain:  { barrier: .3, cost: .1,  sustain: .4,  strength: .1,  seal: .1  },
  strength: { barrier: .3, cost: .1,  sustain: .1,  strength: .4,  seal: .1  },
};
function score(m, req, T, priority, transportSeverity, lightSens) {
  if (m.tmin > T || m.tmax < T) return null;
  let barrier;
  if (req.produce) {
    const ratio = m.otr / req.otr;
    barrier = 100 * Math.max(0, 1 - Math.abs(Math.log10(Math.max(ratio, .001))));
  } else {
    const otrFit = m.otr <= req.otr ? 100 * (1 - m.otr / req.otr) + 20 : Math.max(0, 100 - (m.otr / req.otr - 1) * 40);
    const wvtrFit = m.wvtr <= req.wvtr ? 100 : Math.max(0, 100 - (m.wvtr / req.wvtr - 1) * 40);
    barrier = Math.min(100, (otrFit + wvtrFit) / 2);
  }
  const w = WEIGHTS[priority] || WEIGHTS.balanced;
  const costScore = 100 * (1 - (m.cost - 1) / 4);

  // Rougher handling (regional/export transit) raises the mechanical-strength bar a
  // material has to clear; falling short of it costs more than clearing it gains.
  const reqStrength = 2 + transportSeverity * 1.6;                       // ~3.6 (local) .. 10 (export)
  const strengthGap = m.strength - reqStrength;
  const strengthScore = strengthGap >= 0 ? 100 : Math.max(0, 100 + strengthGap * 25);

  let total = barrier * w.barrier + costScore * w.cost + m.sustain * 10 * w.sustain + strengthScore * w.strength + m.seal * 10 * w.seal;

  // Light/UV sensitivity blends an opacity score into the total, scaled by how much
  // it matters (0 sensitivity = no effect, 5 = up to a fifth of the total score).
  const lightWeight = Math.max(0, Math.min(5, lightSens)) / 5 * 0.2;
  if (lightWeight > 0) total = total * (1 - lightWeight) + (m.light * 10) * lightWeight;

  const costPerM2 = m.cost * (m.thickness / 50) * 0.4;      // rough $/m² from cost index + thickness
  const packCost = costPerM2 * req.areaM2;
  return {
    material: m.name, score: Math.round(Math.max(0, Math.min(100, total))), otr: m.otr, wvtr: m.wvtr,
    thickness: m.thickness, sealability: m.seal, strength: m.strength, recyclable: m.recyclable, note: m.note,
    map: req.produce ? req.gas : "N/A", costIndex: m.cost, packCost: packCost < 0.01 ? packCost.toFixed(3) : packCost.toFixed(2),
    fit: { otr: Math.round(100 * m.otr / req.otr), wvtr: Math.round(100 * m.wvtr / req.wvtr) },
  };
}
function shelfLife(c, m, T, req) {
  const q10 = Math.pow(2.5, (25 - T) / 10);
  let life = c.base_life * (c.resp > 0 ? q10 : 1);
  const closeness = req.produce ? Math.max(0.3, 1 - Math.abs(Math.log10(Math.max(m.otr / req.otr, .001)))) : (m.otr <= req.otr ? 1.2 : 0.6);
  return Math.max(1, Math.round(life * closeness * 10) / 10);
}

const TRANSPORT_SEVERITY = { local: 2, regional: 3.5, export: 5 };

async function submitToBackend(input) {
  const res = await fetch(`${API_BASE}/recommend`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`backend returned ${res.status}`);
  const d = await res.json();
  // Adapt server field names (camelCase, per backend/README.md) to what render() expects.
  const results = d.results.map(r => ({ ...r, shelf_life: r.shelfLifeDays, ml_shelf_life: r.mlPredictedShelfLifeDays }));
  const route = d.route ? {
    from: { city: d.route.from.city, state: d.route.from.state }, to: { city: d.route.to.city, state: d.route.to.state, t: d.route.to.peakTempC, rh: d.route.to.peakRhPct, note: d.route.to.note },
    km: d.route.km, transitDays: d.route.transitDays, effT: d.route.effectiveTempC,
  } : null;
  return { required: d.required, results, route, runId: d.runId };
}

$("#form").onsubmit = async e => {
  e.preventDefault();
  const c = COMMODITIES.find(x => x.name === $("#commodity").value);
  let T = +$("#temp").value, life = +$("#life").value;
  const weight = +$("#weight").value, priority = $("#priority").value;
  const rh = +$("#rh").value, aw = +$("#aw").value;
  const oxSens = +$("#oxSens").value, lightSens = +$("#lightSens").value;
  const transportMode = $("#transport").value;
  const transportSeverity = TRANSPORT_SEVERITY[transportMode] ?? 3.5;

  let route = null;
  let backendInput = null;
  if ($("#routeToggle").checked) {
    const from = getCity("fromState", "fromCity"), to = getCity("toState", "toCity");
    if (from && to) {
      backendInput = { fromState: from.state, fromCity: from.city, toState: to.state, toCity: to.city };
      const km = haversineKm(from, to);
      const transitDays = Math.max(1, Math.ceil(km / 450));
      const effT = Math.max(T, to.t);
      route = { from, to, km, transitDays, effT, baseT: T };
      T = effT; life = life + transitDays;
    }
  }

  visibleCount = 10;

  if (backendOnline) {
    try {
      const input = {
        commodity: c.name, storageType: $("#storage").value, transportMode, priority,
        weightG: weight, temp: +$("#temp").value, rh, life: +$("#life").value, aw, oxSens, lightSens,
        route: backendInput,
      };
      currentData = await submitToBackend(input);
      currentLife = life;
      render(currentData, life);
      return;
    } catch (err) {
      console.error("Backend /api/recommend failed, falling back to local engine:", err);
      backendOnline = false; renderBackendBadge();
    }
  }

  // Offline / fallback path — identical to the original standalone prototype.
  const req = required(c, T, weight, life, rh, aw, oxSens);
  const results = MATERIALS.map(m => {
    const s = score(m, req, T, priority, transportSeverity, lightSens);
    if (!s) return null;
    s.shelf_life = shelfLife(c, m, T, req);
    return s;
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  currentData = { required: req, results, route }; currentLife = life;
  render(currentData, life);
  if (results.length) {
    history.unshift({ created: new Date().toLocaleString(), commodity: c.name, storage: $("#storage").value, temp: T, top_material: results[0].material, score: results[0].score });
    history = history.slice(0, 100); saveHistory();
  }
};

// ---------- "where to buy" links ----------
// These are marketplace SEARCH pages (not fixed product links — stock and
// exact listings change constantly), so they always land on live, real
// results for that material rather than risking a dead/fabricated link.
function buyLinks(materialName) {
  const q = encodeURIComponent(materialName.replace(/\(.*?\)/g, "").trim() + " packaging film roll");
  return {
    tradeindia: `https://www.tradeindia.com/search.html?keyword=${q}`,
    indiamart: `https://dir.indiamart.com/search.mp?ss=${q}`, // bulk/wholesale film & laminate suppliers — usually the most relevant source for actual packaging stock
  };
}
function buyLinksHtml(materialName, compact) {
  const l = buyLinks(materialName);
  const cls = compact ? "" : ' class="tag"';
  return `<a href="${l.tradeindia}" target="_blank" rel="noopener"${cls}>🛒 TradeIndia</a> `
    + `<a href="${l.indiamart}" target="_blank" rel="noopener"${cls}>🛒 IndiaMART</a>`;
}

const fmt = n => n >= 1000 ? n.toLocaleString() : +n.toPrecision(3);
const scoreColor = s => s >= 75 ? "#0e7a63" : s >= 50 ? "#d68a1f" : "#b8432f";
function icon(name) {
  const n = name.toLowerCase();
  if (/glass/.test(n)) return "🍾";
  if (/tin|aluminium|can|foil|metal/.test(n)) return "🥫";
  if (/paper|jute|board|kraft|glassine|wax/.test(n)) return "🧻";
  if (/pla|starch|pha|bio|compost/.test(n)) return "🌱";
  return "📦";
}

function gauge(d) {
  const lo = -2, hi = 5, W = 640, x = v => 20 + (Math.log10(Math.max(v, .01)) - lo) / (hi - lo) * (W - 40);
  let s = `<svg viewBox="0 0 ${W} 110" role="img" aria-label="OTR of each material against the required OTR">`;
  for (let p = lo; p <= hi; p++) s += `<line x1="${x(10 ** p)}" x2="${x(10 ** p)}" y1="40" y2="70" stroke="var(--line)"/><text x="${x(10 ** p)}" y="88" font-size="11" text-anchor="middle" fill="var(--muted)">10${p < 0 ? "⁻" + (-p) : ["⁰","¹","²","³","⁴","⁵"][p]}</text>`;
  s += `<line x1="20" x2="${W - 20}" y1="55" y2="55" stroke="var(--ink)" stroke-width="2"/>`;
  d.results.forEach((m, i) => s += `<circle cx="${x(m.otr)}" cy="${55 + (i % 2 ? 9 : -9)}" r="${i ? 5 : 8}" fill="${i ? "var(--leaf2)" : "var(--leaf)"}"><title>${m.material}: ${m.otr}</title></circle>`);
  const t = x(d.required.otr);
  s += `<path d="M${t} 46 l-6 -14 h12z" fill="var(--amber)"/><text x="${t}" y="24" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink)">${d.required.produce ? "target" : "max allowed"} ${fmt(d.required.otr)}</text></svg>`;
  return s;
}
// Optional side-by-side comparison table for the top N picks. Hidden by
// default — the user opts in with the "Compare top N" toggle button below.
function compareBlock(top) {
  if (top.length < 2) return "";
  const rows = [
    ["Score", m => `<b style="color:${scoreColor(m.score)}">${m.score}</b>`],
    ["OTR, cc/m²·day", m => fmt(m.otr)],
    ["WVTR, g/m²·day", m => fmt(m.wvtr)],
    ["Thickness, µm", m => m.thickness],
    ["Sealability /10", m => m.sealability],
    ["Mechanical strength /10", m => m.strength],
    ["Cost index /5", m => m.costIndex],
    ["Est. cost/pack", m => `~$${m.packCost}`],
    ["Recyclable", m => m.recyclable],
    ["MAP gas mix", m => m.map],
    ["Predicted shelf life", m => `${m.shelf_life} d`],
    ...(top.some(m => m.ml_shelf_life != null) ? [["🤖 ML shelf life", m => m.ml_shelf_life != null ? `${m.ml_shelf_life} d` : "—"]] : []),
    ["Buy", m => buyLinksHtml(m.material, true)],
  ];
  return `
  <div style="margin:14px 0">
    <button type="button" id="compareToggle" class="clearbtn" style="padding:8px 16px;border-radius:999px;font-weight:700">📊 Compare top ${top.length}</button>
    <div id="compareWrap" class="tablewrap" style="display:none;margin-top:12px">
      <table>
        <tr><th>Material</th>${top.map(m => `<th>${icon(m.material)} ${m.material}</th>`).join("")}</tr>
        ${rows.map(([label, fn]) => `<tr><td><b>${label}</b></td>${top.map(m => `<td>${fn(m)}</td>`).join("")}</tr>`).join("")}
      </table>
    </div>
  </div>`;
}

let currentData = null, currentLife = null, visibleCount = 10;
const PAGE_SIZE = 10;
function render(d, life) {
  const q = d.required, top = d.results[0];
  if (!top) { $("#out").innerHTML = `<div class="empty">No material in the database survives this temperature. Try a different storage type.</div>`; return; }
  const shown = d.results.slice(0, visibleCount);
  const remaining = d.results.length - shown.length;
  const routeCard = d.route ? `
  <div class="routeImpact">
    <h4>🗺️ ${d.route.from.city}, ${d.route.from.state} → ${d.route.to.city}, ${d.route.to.state}</h4>
    <div class="routeStats">
      <span><b>${d.route.km.toLocaleString()} km</b> distance</span>
      <span>~<b>${d.route.transitDays} day${d.route.transitDays > 1 ? "s" : ""}</b> transit (road, ~450 km/day)</span>
      <span>Destination climate: <b>${d.route.to.t}°C</b> peak, <b>${d.route.to.rh}%</b> RH — ${d.route.to.note}</span>
    </div>
    <div class="note">Design temperature raised to <b>${d.route.effT}°C</b> (worst of your storage setting and the destination's peak) and target shelf life extended by the ${d.route.transitDays}-day transit, so the recommendation below already accounts for the route.</div>
  </div>` : "";
  $("#out").innerHTML = routeCard + `
  <div class="chips">
    <div class="chip" style="animation-delay:0ms"><b>${fmt(q.otr)}</b><span>${q.produce ? "required" : "max"} OTR, cc/m²·day</span></div>
    <div class="chip" style="animation-delay:60ms"><b>${fmt(q.wvtr)}</b><span>max WVTR, g/m²·day</span></div>
    <div class="chip" style="animation-delay:120ms"><b>${top.shelf_life} d</b><span>engine's predicted shelf life (goal ${life} d)</span></div>
    ${top.ml_shelf_life != null ? `<div class="chip" style="animation-delay:150ms"><b>${top.ml_shelf_life} d</b><span>🤖 ML model's prediction</span></div>` : ""}
    <div class="chip" style="animation-delay:180ms"><b style="font-size:.95rem">${q.gas}</b><span>MAP gas mix</span></div>
  </div>
  ${d.runId ? `
  <div class="note" id="feedbackBlock" style="margin:10px 0 0;padding:10px 14px;border-radius:12px;background:rgba(20,70,40,.05)">
    Come back once you've actually tried this pack —
    <input type="number" id="feedbackDays" min="0.1" step="0.1" placeholder="days" style="width:70px;padding:4px 6px;border-radius:6px;border:1px solid var(--line)">
    <button type="button" id="feedbackBtn" class="clearbtn" style="padding:6px 14px;font-size:.8rem">Report actual shelf life for ${top.material}</button>
    <span id="feedbackMsg" style="margin-left:8px;font-weight:600"></span>
  </div>` : ""}
  <div class="gauge"><strong>Oxygen barrier on a log scale</strong>${gauge(d)}</div>
  <p class="note" style="margin:16px 0 4px">Showing <b>${shown.length}</b> of <b>${d.results.length}</b> compatible materials, ranked by fit.</p>
  ${compareBlock(d.results.slice(0, 5))}` +
  shown.map((m, i) => `
  <div class="card ${i ? "" : "open"}" tabindex="0" role="button" style="animation-delay:${i * 40}ms">
    <h3><span class="nm"><span class="materialIcon">${icon(m.material)}</span>${m.material}</span><span style="display:flex;align-items:center;gap:.6rem"><span class="scoreBadge" style="background:${scoreColor(m.score)}">${m.score}</span><span class="chev">▾</span></span></h3>
    <div class="bar"><i data-w="${m.score}"></i></div>
    <span class="tag">MAP: ${m.map}</span><span class="tag ${m.recyclable === "No" ? "no" : ""}">Recycle: ${m.recyclable}</span><span class="tag">~$${m.packCost}/pack</span>
    <div class="specWrap"><div class="specInner"><div class="spec">
      <div><span>OTR</span>${fmt(m.otr)}</div><div><span>WVTR</span>${fmt(m.wvtr)}</div>
      <div><span>Thickness</span>${m.thickness} µm</div><div><span>Sealability</span>${m.sealability}/10</div>
      <div><span>Mechanical strength</span>${m.strength}/10</div><div><span>Barrier fit</span>O₂ ${m.fit.otr}% · H₂O ${m.fit.wvtr}%</div>
      <div><span>Cost index</span>${m.costIndex}/5</div><div><span>Est. material cost</span>~$${m.packCost} per pack</div>
      ${m.ml_shelf_life != null ? `<div><span>🤖 ML shelf-life estimate</span>${m.ml_shelf_life} d</div>` : ""}
      <div style="grid-column:1/-1">${m.note}</div>
      <div style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span style="color:var(--muted);font-size:.8rem">Buy this film:</span>${buyLinksHtml(m.material)}</div>
    </div></div></div>
  </div>`).join("") +
  (remaining > 0 ? `<div style="text-align:center;margin-top:22px"><button type="button" id="loadMoreBtn" class="clearbtn" style="padding:12px 22px;border-radius:999px;font-weight:700">Load ${Math.min(PAGE_SIZE, remaining)} more (${remaining} left) ↓</button></div>` : "");
  document.querySelectorAll(".card").forEach(c => {
    c.onclick = () => c.classList.toggle("open");
    c.onkeydown = e => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), c.click());
  });
  requestAnimationFrame(() => document.querySelectorAll(".bar i").forEach(b => b.style.width = b.dataset.w + "%"));
  const cmpBtn = $("#compareToggle");
  if (cmpBtn) cmpBtn.onclick = () => {
    const w = $("#compareWrap");
    const show = w.style.display === "none";
    w.style.display = show ? "block" : "none";
    cmpBtn.textContent = show ? "📊 Hide comparison" : `📊 Compare top ${d.results.slice(0, 5).length}`;
  };
  const fb = $("#feedbackBtn");
  if (fb) fb.onclick = async () => {
    const days = +$("#feedbackDays").value;
    const msg = $("#feedbackMsg");
    if (!(days > 0)) { msg.textContent = "Enter a number of days first."; msg.style.color = "#b8432f"; return; }
    try {
      const res = await fetch(`${API_BASE}/history/${d.runId}/feedback`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materialId: top.materialId, actualShelfLifeDays: days }),
      });
      if (!res.ok) throw new Error(await res.text());
      msg.textContent = "Thanks — logged for the ML model to learn from."; msg.style.color = "#0e7a63";
      fb.disabled = true;
    } catch (err) {
      msg.textContent = "Couldn't save feedback (is the backend running?)."; msg.style.color = "#b8432f";
    }
  };
  const lm = $("#loadMoreBtn");
  if (lm) lm.onclick = () => { visibleCount += PAGE_SIZE; render(currentData, currentLife); };
}

/* ---------- tables ---------- */
function table(el, cols, data) {
  let asc = true;
  const draw = rows => el.innerHTML = `<tr>${cols.map(c => `<th data-k="${c[0]}">${c[1]}</th>`).join("")}</tr>` +
    (rows.map(r => `<tr>${cols.map(c => `<td>${r[c[0]] ?? ""}</td>`).join("")}</tr>`).join("") || `<tr><td>No entries yet. Run a recommendation first.</td></tr>`);
  draw(data);
  el.onclick = e => { const k = e.target.dataset.k; if (!k) return; asc = !asc; draw([...data].sort((a, b) => (a[k] > b[k] ? 1 : -1) * (asc ? 1 : -1))); };
}
const loadMaterials = () => table($("#matTable"), [["name","Material"],["otr","OTR"],["wvtr","WVTR"],["thickness","Thickness µm"],["cost","Cost 1-5"],["sustain","Sustain /10"],["strength","Strength"],["seal","Seal"],["light","Light barrier /10"],["tmin","Min °C"],["tmax","Max °C"],["recyclable","Recyclable"],["source","Source"],["buy","Buy"]],
  MATERIALS.map(m => ({ ...m, buy: buyLinksHtml(m.name, true) })));
const loadCommodities = () => table($("#comTable"),
  [["name","Commodity"],["category","Category"],["moisture","Moisture %"],["fat","Fat %"],["aw","Water activity"],["resp","Resp mL/kg·h@10°C"],["source","Source"],["usda_temp","USDA temp"],["usda_rh","USDA RH"],["usda_life","USDA life"]],
  COMMODITIES.map(c => ({ ...c, name: foodLabel(c.name), usda_temp: c.usda ? c.usda.temp : "—", usda_rh: c.usda ? c.usda.rh : "—", usda_life: c.usda ? c.usda.life : "—" })));
const HIST_COLS_OFFLINE = [["created","When"],["commodity","Commodity"],["storage","Storage"],["temp","°C"],["top_material","Top pick"],["score","Score"]];
const HIST_COLS_ONLINE = [["created","When"],["commodity","Commodity"],["storage","Storage"],["temp","°C"],["top_material","Top pick"],["score","Score"],["engine_life","Engine est."],["ml_life","🤖 ML est."],["actual_life","Actual"]];
async function loadHistory() {
  if (!backendOnline) {
    table($("#hisTable"), HIST_COLS_OFFLINE, history.map(h => ({ ...h, commodity: foodLabel(h.commodity) })));
    return;
  }
  try {
    const rows = await (await fetch(`${API_BASE}/history?limit=50`)).json();
    table($("#hisTable"), HIST_COLS_ONLINE, rows.map(r => ({
      created: new Date(r.created_at).toLocaleString(),
      commodity: foodLabel(r.commodity),
      storage: r.storage_type,
      temp: r.storage_temp_c,
      top_material: r.top_material ?? "—",
      score: r.top_score ?? "—",
      engine_life: r.predicted_shelf_life_days != null ? `${r.predicted_shelf_life_days} d` : "—",
      ml_life: r.ml_predicted_shelf_life_days != null ? `${r.ml_predicted_shelf_life_days} d` : "—",
      actual_life: r.actual_shelf_life_days != null ? `${r.actual_shelf_life_days} d ✓` : "—",
    })));
  } catch (e) {
    backendOnline = false; renderBackendBadge();
    table($("#hisTable"), HIST_COLS_OFFLINE, history.map(h => ({ ...h, commodity: foodLabel(h.commodity) })));
  }
}
const loadMultilayers = () => table($("#mlTable"), [["structure","Structure"],["process","Process"],["application","Typical application"]], MULTILAYERS);
const loadMetallization = () => $("#metTable").innerHTML = `<tr><th>Metal layer (nm)</th><th>O₂ permeability, cm³ d⁻¹ bar⁻¹ m⁻²</th></tr>` +
  METALLIZATION.map(r => `<tr><td>${r.metal_nm}</td><td>${r.po2}</td></tr>`).join("");
const loadBIS = () => table($("#bisTable"), [["commodity","Commodity"],["materials","BIS-recommended materials"],["standard","Reference"]], BIS_PACKAGING.map(b => ({ ...b, commodity: foodLabel(b.commodity) })));
$("#clear").onclick = () => {
  if (backendOnline) { alert("History is now stored server-side in Postgres (shared, no auth yet — see backend/README.md) and can't be cleared from here."); return; }
  history = []; saveHistory(); loadHistory();
};

/* ---------- route ---------- */
let STATES = [...new Set(INDIA_CITIES.map(c => c.state))];
function recomputeStates() { STATES = [...new Set(INDIA_CITIES.map(c => c.state))]; }
function fillStates(sel) { sel.innerHTML = STATES.map(s => `<option>${s}</option>`).join(""); }
function fillCities(citySel, state) { citySel.innerHTML = INDIA_CITIES.filter(c => c.state === state).map(c => `<option>${c.city}</option>`).join(""); }
function initRoute(statePfx, cityPfx) {
  const stateSel = $("#" + statePfx), citySel = $("#" + cityPfx);
  fillStates(stateSel); fillCities(citySel, stateSel.value);
  stateSel.onchange = () => fillCities(citySel, stateSel.value);
}
$("#routeToggle").onchange = e => $("#routePanel").classList.toggle("show", e.target.checked);
function getCity(statePfx, cityPfx) { return INDIA_CITIES.find(c => c.state === $("#" + statePfx).value && c.city === $("#" + cityPfx).value); }

/* ---------- backend status badge ---------- */
function renderBackendBadge() {
  let badge = $("#backendBadge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "backendBadge";
    badge.style.cssText = "display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;font-size:.72rem;font-weight:700;margin-left:8px;";
    $(".topbarRight").prepend(badge);
  }
  badge.title = backendOnline
    ? `Connected to ${API_BASE} — recommendations, history and ML predictions are live from Postgres.`
    : `Could not reach ${API_BASE} — running standalone on the built-in data and local scoring engine (same math, no history sync, no ML).`;
  badge.innerHTML = backendOnline
    ? `<span style="width:7px;height:7px;border-radius:50%;background:#2f8f5b"></span> Live backend`
    : `<span style="width:7px;height:7px;border-radius:50%;background:#d68a1f"></span> Offline demo`;
  badge.style.background = backendOnline ? "rgba(47,143,91,.12)" : "rgba(214,138,31,.14)";
  badge.style.color = backendOnline ? "#0e7a63" : "#8a5a12";
}

/* ---------- boot ---------- */
(async () => {
  await checkBackend();

  if (backendOnline) {
    try {
      const [comRes, matRes, cityRes] = await Promise.all([
        fetch(`${API_BASE}/commodities`), fetch(`${API_BASE}/materials`), fetch(`${API_BASE}/cities`),
      ]);
      const [comRows, matRows, cityRows] = await Promise.all([comRes.json(), matRes.json(), cityRes.json()]);
      if (comRows.length && matRows.length && cityRows.length) {
        COMMODITIES.length = 0; COMMODITIES.push(...comRows.map(mapBackendCommodity));
        MATERIALS.length = 0; MATERIALS.push(...matRows.map(mapBackendMaterial));
        INDIA_CITIES.length = 0; INDIA_CITIES.push(...cityRows.map(mapBackendCity));
      } else {
        backendOnline = false; // reachable but empty (schema not seeded) — fall back to local data
      }
    } catch (e) {
      backendOnline = false;
    }
  }

  recomputeStates();
  initRoute("fromState", "fromCity"); initRoute("toState", "toCity");
  renderBackendBadge();

  $("#commodity").innerHTML = COMMODITIES.map(c => `<option value="${c.name}">${foodLabel(c.name)}</option>`).join("");
  fill(); loadMaterials(); loadCommodities();
  moveIndicator(document.querySelector(".tab.on"));
})();