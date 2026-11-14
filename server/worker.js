/* Good.2.eat — Cloudflare Worker: citește o poză cu spatele ambalajului (ingrediente + tabel nutrițional)
   Variabile / secrete (Settings → Variables and Secrets):
     ANTHROPIC_API_KEY  (Secret)  cheia ta Anthropic
     ALLOWED_ORIGIN     (Text)    ex: https://USERNAME.github.io   (mai mulți: separați cu virgulă)
     MODEL              (Text, opțional)  implicit claude-haiku-4-5
     MONTHLY_PER_CLIENT (Text, opțional)  citiri AI pe lună per utilizator, implicit 10
     DAILY_GLOBAL       (Text, opțional)  citiri AI pe zi, toți utilizatorii, implicit 300
     REFUND_CAP         (Text, opțional)  câte citiri care adaugă un produs nou NU se scad din limita lunară, implicit 20 / lună / utilizator
   D1 (OBLIGATORIU): binding cu numele DB — baza comună, contoarele de limite și statisticile; tabelele se creează singure
   KV (USAGE): nu mai e folosit, poate fi lăsat sau șters
     IP_SALT            (Secret, recomandat)  un text lung oarecare; IP-urile se păstrează doar ca amprentă (hash)
     STATS_KEY          (Secret, opțional)    parola pentru pagina de statistici: /stats?key=...

   Rute:
     POST /            citește o poză (corp JSON: image, media_type, lang, code opțional, store opțional) și, dacă există code, salvează în baza comună
     GET  /p/{code}    caută produsul în baza comună (?store=Lidl pentru codurile de magazin)
     POST /confirm     {code, store?} — un alt utilizator confirmă că datele corespund ambalajului (câte o dată per produs)
     POST /report      {code, store?} — un utilizator semnalează date greșite; la 2 semnalări distincte produsul e ascuns
     POST /m           numele unui eveniment (text simplu) — contor zilnic anonim, fără ID și fără IP
     GET  /stats?key=  tabel cu statisticile pe ultimele 30 de zile (doar cu STATS_KEY)

   Coduri care încep cu 2:
     - cântărite la raion (13 cifre 21–29, 12 cifre 2…, 13 cifre 02…): conțin greutatea/prețul, nu se partajează
     - marcă proprie a lanțului (8 cifre 2…, 13 cifre 20…, ex. Lidl): se partajează, cheia din baza comună
       este cod@magazin (ex. 20005825@lidl), ca același cod de la lanțuri diferite să nu se amestece */

const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_BODY = 4_500_000; // ~4.5 MB

const SYSTEM = `You read photos of food packaging. Extract ONLY what is printed on the package; never guess or invent.
Return a single JSON object, nothing else, with this exact shape:
{"product_name": string|null,
 "ingredients": string|null,   // the full ingredient list as printed, same language, comma-separated, keep E-numbers and allergen emphasis words; null if not visible
 "nutrition_per": "100g"|"100ml"|"portion"|null,
 "nutrition": {"energy_kcal":number|null,"fat":number|null,"saturated_fat":number|null,"carbohydrates":number|null,"sugars":number|null,"fiber":number|null,"protein":number|null,"salt":number|null},
 "barcode_digits": string|null, // the digits printed under the barcode, if a barcode is visible in the photo; null otherwise
 "readable": boolean}          // false if the photo is too blurry/dark/cropped to read
Rules: values in grams per the column given by nutrition_per (prefer the 100 g / 100 ml column). Energy in kcal (convert from kJ by dividing by 4.184 if kcal is missing). If only sodium is printed, convert salt = sodium × 2.5. Decimal comma → decimal point. Use null for anything not printed.`;

function cors(origin, allowed) {
  const ok = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Id",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

/* contoare de limite în D1 (atomice, fără limita de 1000 de scrieri/zi a KV) */
async function bump(env, key, limit, ttl = 60 * 60 * 26) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO usage (k, n, exp) VALUES (?, 1, ?)
     ON CONFLICT(k) DO UPDATE SET n = n + 1, exp = MAX(exp, excluded.exp) WHERE n < ?
     RETURNING n`).bind(key, now + ttl, limit).first();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM usage WHERE exp < ?").bind(now).run();
  return !!row;
}
async function unbump(env, key) {
  await env.DB.prepare("UPDATE usage SET n = MAX(n - 1, 0) WHERE k = ?").bind(key).run();
}

/* ---------- baza comună (D1) ---------- */
let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY, name TEXT, ingredients TEXT, nutrition TEXT, per TEXT,
    barcode_ok INTEGER DEFAULT 0, client TEXT, reports INTEGER DEFAULT 0, confirms INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT)`).run();
  try { await env.DB.prepare("ALTER TABLE products ADD COLUMN confirms INTEGER DEFAULT 0").run(); } catch (e) {}   // baze create înainte de această versiune
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS votes (code TEXT, ver TEXT, client TEXT, kind TEXT, PRIMARY KEY (code, ver, client, kind))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS stats (day TEXT, ev TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (day, ev))`).run();
  tableReady = true;
}
/* ---------- statistici anonime: doar contoare pe zi, fără identificatori ---------- */
const CLIENT_EVENTS = new Set(["new_user","active_day","active_month","active_day_pwa","scan_off_full","scan_off_partial",
  "scan_not_found","scan_internal","ocr_local","install","feedback","privacy_open","ai_declined","shared_confirm","compare","alt_open","alt_found","shelf_on","shortcut",
  "name_search","store_pick"]);
async function count(env, ev) {
  if (!env.DB) return;
  try {
    await ensureTable(env);
    await env.DB.prepare("INSERT INTO stats (day, ev, n) VALUES (?, ?, 1) ON CONFLICT(day, ev) DO UPDATE SET n = n + 1")
      .bind(new Date().toISOString().slice(0, 10), ev).run();
  } catch (e) {}
}
async function statsPage(env) {
  await ensureTable(env);
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare("SELECT day, ev, n FROM stats WHERE day >= ? ORDER BY day DESC").bind(since).all();
  const prod = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(reports >= 2) AS hidden, SUM(barcode_ok) AS bc, SUM(confirms >= 1) AS ver, SUM(code LIKE '%@%') AS st FROM products").first();
  const days = [...new Set(results.map(r => r.day))];
  const evs = [...new Set(results.map(r => r.ev))].sort();
  const cell = (d, e) => (results.find(r => r.day === d && r.ev === e) || {}).n || "";
  const tot = e => results.filter(r => r.ev === e).reduce((s, r) => s + r.n, 0);
  const th = evs.map(e => `<th>${e}</th>`).join("");
  const rows = days.map(d => `<tr><td>${d}</td>${evs.map(e => `<td>${cell(d, e)}</td>`).join("")}</tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Good.2.eat — statistici</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#123}table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #ccd;padding:4px 6px;text-align:right;white-space:nowrap}th{background:#eef5f0;position:sticky;top:0}td:first-child{text-align:left}.w{overflow-x:auto}</style>
<h1>Good.2.eat — ultimele 30 de zile</h1>
<p>Produse în baza comună: <b>${prod.n || 0}</b> (de marcă proprie a magazinelor: ${prod.st || 0}; confirmate de un al doilea utilizator: ${prod.ver || 0}; cu cod de bare văzut în poză: ${prod.bc || 0}; ascunse după semnalări: ${prod.hidden || 0})</p>
<p>Total 30 zile — utilizatori activi/zi (sumă): <b>${tot("active_day")}</b>, utilizatori noi: <b>${tot("new_user")}</b>, scanări: <b>${tot("scan_off_full") + tot("scan_off_partial") + tot("scan_not_found") + tot("scan_internal")}</b>, citiri AI: <b>${tot("ai_read")}</b>, produse adăugate: <b>${tot("ai_saved")}</b></p>
<div class="w"><table><tr><th>zi</th>${th}</tr>${rows}</table></div>`;
}
async function ipKey(env, ip, month) {
  const data = new TextEncoder().encode(`${env.IP_SALT || "g2e-default-salt"}|${month}|${ip}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* cântărite la raion: greutatea sau prețul sunt în cod, nu se partajează */
const isWeighed = c => (c.length === 13 && /^(2[1-9]|02)/.test(c)) || (c.length === 12 && c[0] === "2");
/* marcă proprie a lanțului (ex. Lidl): valabile doar în lanțul respectiv */
const isStoreCode = c => (c.length === 8 && c[0] === "2") || (c.length === 13 && c.startsWith("20"));
const validCode = c => /^\d{8,14}$/.test(c) && !isWeighed(c);
const sameCode = (a, b) => a.replace(/^0+/, "") === b.replace(/^0+/, "");
const storeSlug = s => {
  const v = String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "").slice(0, 20);
  return v === "other" || v === "altul" ? "" : v;
};
/* cheia sub care se salvează un produs: codul simplu sau, la codurile de magazin, cod@magazin */
const saveKey = (code, store) => isStoreCode(code) && storeSlug(store) ? `${code}@${storeSlug(store)}` : code;

const rowOut = row => ({ code: row.code.split("@")[0], store: row.code.includes("@") ? row.code.split("@")[1] : null,
  name: row.name, ingredients: row.ingredients, nutrition: row.nutrition ? JSON.parse(row.nutrition) : null,
  per: row.per, barcode_ok: !!row.barcode_ok, confirms: row.confirms || 0, updated_at: row.updated_at });

/* găsește rândul din baza comună pentru un cod (și, opțional, magazin); întoarce rândul brut */
async function findRow(env, code, store) {
  await ensureTable(env);
  if (isStoreCode(code)) {
    const slug = storeSlug(store);
    if (slug) {
      const r = await env.DB.prepare("SELECT * FROM products WHERE code = ? AND reports < 2").bind(`${code}@${slug}`).first();
      if (r) return r;
    }
    const plain = await env.DB.prepare("SELECT * FROM products WHERE code = ? AND reports < 2").bind(code).first();
    if (plain) return plain;
    if (slug) return null;                         // magazin cunoscut, dar alt lanț are codul: nu amestecăm
    const { results } = await env.DB.prepare("SELECT * FROM products WHERE code LIKE ? AND reports < 2 LIMIT 2").bind(`${code}@%`).all();
    return results.length === 1 ? results[0] : null;  // fără magazin: doar dacă un singur lanț are codul
  }
  const alt = code.length === 12 ? "0" + code : code.length === 13 && code[0] === "0" ? code.slice(1) : code;
  return await env.DB.prepare("SELECT * FROM products WHERE code IN (?, ?) AND reports < 2 LIMIT 1").bind(code, alt).first();
}
async function getShared(env, code, store) {
  const row = await findRow(env, code, store);
  return row ? rowOut(row) : null;
}

async function saveShared(env, key, cid, clean, barcodeOk) {
  await ensureTable(env);
  const nutr = Object.values(clean.nutrition).filter(v => v !== null).length >= 4 && clean.nutrition_per !== "portion"
    ? JSON.stringify(clean.nutrition) : null;
  if (!clean.ingredients && !nutr) return false;
  const now = new Date().toISOString();
  const old = await env.DB.prepare("SELECT * FROM products WHERE code = ?").bind(key).first();
  if (!old || old.reports >= 2) {          // produs nou sau semnalat ca greșit: se (re)scrie
    await env.DB.prepare(`INSERT OR REPLACE INTO products (code,name,ingredients,nutrition,per,barcode_ok,client,reports,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,0,?,?)`).bind(key, clean.product_name, clean.ingredients, nutr, clean.nutrition_per, barcodeOk ? 1 : 0, cid, now, now).run();
    return "new";
  }
  // produs existent: se completează doar câmpurile lipsă, nu se suprascrie ce e deja
  const r = await env.DB.prepare(`UPDATE products SET
      name = COALESCE(name, ?), ingredients = COALESCE(ingredients, ?), nutrition = COALESCE(nutrition, ?),
      per = COALESCE(per, ?), barcode_ok = MAX(barcode_ok, ?), updated_at = ?
    WHERE code = ? AND (name IS NULL OR ingredients IS NULL OR nutrition IS NULL)`)
    .bind(clean.product_name, clean.ingredients, nutr, clean.nutrition_per, barcodeOk ? 1 : 0, now, key).run();
  return r.meta && r.meta.changes ? "filled" : false;
}

/* o persoană votează (confirmă / semnalează) o versiune a unui produs o singură dată; limită zilnică ca să nu se poată face în masă */
async function vote(env, code, store, cid, kind, ipk, day) {
  const row = await findRow(env, code, store);
  if (!row) return { ok: false };
  const key = row.code;
  if (!(await bump(env, `v:${day}:${ipk}`, 80)) || !(await bump(env, `v:${day}:${cid}`, 60))) return { ok: false, limited: true };
  if (kind === "c" && row.client === cid) return { ok: true, own: true };
  const r = await env.DB.prepare("INSERT OR IGNORE INTO votes (code, ver, client, kind) VALUES (?,?,?,?)").bind(key, row.created_at, cid, kind).run();
  if (!(r.meta && r.meta.changes)) return { ok: true, dup: true };
  await env.DB.prepare(kind === "c" ? "UPDATE products SET confirms = confirms + 1 WHERE code = ?" : "UPDATE products SET reports = reports + 1 WHERE code = ?").bind(key).run();
  return { ok: true };
}

export default {
  async fetch(req, env) {
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get("Origin") || "";
    const h = cors(origin, allowed);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname === "/stats") {     // deschis direct din browser, fără Origin
        if (!env.STATS_KEY || u.searchParams.get("key") !== env.STATS_KEY || !env.DB) return new Response("Not found", { status: 404 });
        return new Response(await statsPage(env), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
    }
    if (!allowed.includes("*") && !allowed.includes(origin)) return json({ error: "origin" }, 403, h);
    const url = new URL(req.url);
    const cid0 = (req.headers.get("X-Client-Id") || "anon").slice(0, 64);

    if (req.method === "GET" && url.pathname.startsWith("/p/")) {
      const code = url.pathname.slice(3).replace(/\D/g, "");
      if (!env.DB || !validCode(code)) return json({ found: false }, 200, h);
      try { const p = await getShared(env, code, url.searchParams.get("store")); await count(env, p ? "shared_hit" : "shared_miss"); return json(p ? { found: true, product: p } : { found: false }, 200, h); }
      catch (e) { return json({ found: false, error: "db" }, 200, h); }
    }
    if (req.method === "POST" && (url.pathname === "/report" || url.pathname === "/confirm")) {
      let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400, h); }
      const code = String(b.code || "").replace(/\D/g, "");
      if (!env.DB || !validCode(code)) return json({ ok: false }, 200, h);
      const day = new Date().toISOString().slice(0, 10);
      const ipk = await ipKey(env, req.headers.get("CF-Connecting-IP") || "?", day.slice(0, 7));
      try {
        const kind = url.pathname === "/confirm" ? "c" : "r";
        const res = await vote(env, code, b.store, cid0, kind, ipk, day);
        if (res.ok && !res.dup && !res.own) await count(env, kind === "c" ? "confirm" : "report");
        return json(res, 200, h);
      } catch (e) { return json({ ok: false, error: "db" }, 200, h); }
    }
    if (req.method === "POST" && url.pathname === "/m") {
      const ev = (await req.text()).trim().slice(0, 40);
      if (CLIENT_EVENTS.has(ev)) await count(env, ev);
      return new Response(null, { status: 204, headers: h });
    }
    if (req.method !== "POST") return json({ error: "method" }, 405, h);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "server_not_configured" }, 500, h);

    const len = parseInt(req.headers.get("Content-Length") || "0", 10);
    if (len > MAX_BODY) return json({ error: "too_large" }, 413, h);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400, h); }
    const b64 = String(body.image || "").replace(/^data:image\/[a-z+]+;base64,/, "");
    const media = ["image/jpeg", "image/png", "image/webp"].includes(body.media_type) ? body.media_type : "image/jpeg";
    if (b64.length < 1000 || b64.length > MAX_BODY) return json({ error: "bad_image" }, 400, h);

    if (!env.DB) return json({ error: "server_not_configured" }, 500, h);

    // limite: lunare per utilizator și per IP (amprentă), zilnică globală; dacă un pas eșuează, se anulează cei dinainte
    const day = new Date().toISOString().slice(0, 10);
    const cid = (req.headers.get("X-Client-Id") || "anon").slice(0, 64);
    const ip = req.headers.get("CF-Connecting-IP") || "?";   // nu se salvează: doar o amprentă (hash) lunară
    const month = day.slice(0, 7);
    const monthTtl = 60 * 60 * 24 * 35;
    const perClient = parseInt(env.MONTHLY_PER_CLIENT || "10", 10);
    const global = parseInt(env.DAILY_GLOBAL || "300", 10);
    const refundCap = parseInt(env.REFUND_CAP || "20", 10);
    const kIp = `ip:${month}:${await ipKey(env, ip, month)}`, kCl = `c:${month}:${cid}`, kGl = `g:${day}`;
    try {
      await ensureTable(env);
      if (!(await bump(env, kIp, perClient * 3, monthTtl))) { await count(env, "ai_limit"); return json({ error: "limit_client" }, 429, h); }
      if (!(await bump(env, kCl, perClient, monthTtl))) { await unbump(env, kIp); await count(env, "ai_limit"); return json({ error: "limit_client" }, 429, h); }
      if (!(await bump(env, kGl, global))) { await unbump(env, kIp); await unbump(env, kCl); await count(env, "ai_limit_global"); return json({ error: "limit_global" }, 429, h); }
    } catch (e) { return json({ error: "limits_unavailable" }, 503, h); }

    const lang = body.lang === "en" ? "English" : "Romanian";
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.MODEL || DEFAULT_MODEL,
          max_tokens: 1200,
          system: SYSTEM,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: media, data: b64 } },
              { type: "text", text: `Extract the data from this package photo. The user's app language is ${lang}; keep ingredient text in the language printed on the package. JSON only.` },
            ],
          }],
        }),
      });
    } catch (e) {
      return json({ error: "upstream_network" }, 502, h);
    }
    if (!r.ok) return json({ error: "upstream", status: r.status }, 502, h);

    const data = await r.json();
    const txt = (data.content || []).map(c => c.text || "").join("");
    const m = txt.match(/\{[\s\S]*\}/);
    let out;
    try { out = JSON.parse(m ? m[0] : txt); } catch { return json({ error: "parse" }, 502, h); }

    const num = v => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
    const n = out.nutrition || {};
    const clean = {
      product_name: typeof out.product_name === "string" ? out.product_name.slice(0, 120) : null,
      ingredients: typeof out.ingredients === "string" && out.ingredients.trim().length > 5 ? out.ingredients.trim().slice(0, 3000) : null,
      nutrition_per: ["100g", "100ml", "portion"].includes(out.nutrition_per) ? out.nutrition_per : null,
      nutrition: {
        "energy-kcal_100g": num(n.energy_kcal), fat_100g: num(n.fat), "saturated-fat_100g": num(n.saturated_fat),
        carbohydrates_100g: num(n.carbohydrates), sugars_100g: num(n.sugars), fiber_100g: num(n.fiber),
        proteins_100g: num(n.protein), salt_100g: num(n.salt),
      },
      readable: out.readable !== false,
    };

    // salvare în baza comună: doar ce a citit AI-ul din poză (nu text scris de utilizator)
    const code = String(body.code || "").replace(/\D/g, "");
    const bc = typeof out.barcode_digits === "string" ? out.barcode_digits.replace(/\D/g, "") : "";
    clean.barcode_seen = bc.length >= 8;
    clean.barcode_match = clean.barcode_seen ? sameCode(bc, code) : null;
    clean.saved = false; clean.created = false; clean.refunded = false;
    if (validCode(code) && clean.readable && clean.barcode_match !== false) {
      try {
        const res = await saveShared(env, saveKey(code, body.store), cid, clean, clean.barcode_match === true);
        clean.saved = !!res; clean.created = res === "new";
        // un produs nou în baza comună nu se scade din limita lunară (până la REFUND_CAP pe lună): contribuția e scopul
        if (clean.created && (await bump(env, `rf:${month}:${cid}`, refundCap, monthTtl))) {
          await unbump(env, kCl); await unbump(env, kIp); clean.refunded = true;
        }
      } catch (e) { clean.saved = false; }
    }
    await count(env, "ai_read");
    if (clean.saved) await count(env, "ai_saved");
    if (clean.created) await count(env, "ai_new_product");
    return json(clean, 200, h);
  },
};
