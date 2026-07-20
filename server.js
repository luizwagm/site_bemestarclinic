/* ==========================================================================
   server.js — Gerenciador do site BemEstarClinic
   Node puro + SQLite nativo (node:sqlite) — zero dependências.
   · Site:   http://localhost:5185/
   · Painel: http://localhost:5185/admin/   (senha inicial: bemestar-admin)
   "Publicar" regenera o index.html (marcadores <!--#KEY-->) e o config.js.
   ========================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = 5185;
const UPLOAD_DIR = path.join(ROOT, "assets", "img", "uploads");
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(ROOT, "data", "site.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, text TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS portfolio (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, subtitle TEXT, image TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS testimonials (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, name TEXT, role TEXT, initials TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, bio TEXT, photo TEXT, sort INTEGER DEFAULT 0);
`);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const getS = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
const setS = (k, v) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/* ------------------------------- Seed ------------------------------------ */
function seed() {
  if (getS("hero_title")) return;
  const S = {
    admin_password_hash: sha("bemestar-admin"),
    hero_badge: "🪷 Clínica de bem-estar em Caruaru-PE · online para o mundo todo",
    hero_title: "Cuidar da mente e do corpo é um ato de <em>bem-estar</em>.",
    hero_lead: "Psicanálise, ozonioterapia e terapias integrativas em um espaço acolhedor no coração de Caruaru — e atendimento online para você, onde estiver.",
    stats: JSON.stringify([
      { num: "10+", label: "anos cuidando de pessoas" }, { num: "3mil+", label: "atendimentos realizados" },
      { num: "100%", label: "acolhimento e sigilo" }, { num: "On-line", label: "para o mundo todo" },
    ]),
    about_title: "Um espaço pensado para acolher a sua história.",
    about_lead: "A BemEstarClinic nasceu para unir escuta qualificada e terapias que promovem saúde de forma integral. Cada atendimento é conduzido com ética, sigilo e um olhar único para você — do primeiro contato ao acompanhamento contínuo.",
    about_bullets: JSON.stringify([
      "Atendimento humanizado, ético e sigiloso",
      "Profissionais qualificados e em constante formação",
      "Espaço acolhedor, climatizado e de fácil acesso",
      "Sessões presenciais em Caruaru ou online",
    ]),
    whatsapp: "5500000000000",
    whatsapp_display: "(87) 00000-0000",
    contact_email: "contato@bemestarclinic.com.br",
    instagram: "bemestarclinic_",
    footer_tagline: "Psicanálise, ozonioterapia e terapias integrativas. Presencial em Caruaru-PE e online para o mundo todo.",
  };
  for (const [k, v] of Object.entries(S)) setS(k, v);

  [["Psicanálise", "Escuta qualificada para elaborar dores, angústias e travas emocionais. Sessões individuais, presenciais ou online."],
   ["Ozonioterapia", "Aplicações de ozônio medicinal como terapia complementar: mais disposição, imunidade e qualidade de vida."],
   ["Terapia Online", "Atendimento por videochamada com o mesmo acolhimento e sigilo — para você, em qualquer lugar do mundo."],
   ["Terapia de Casal e Família", "Um espaço seguro para reconstruir diálogo, vínculos e acordos com mediação profissional."],
   ["Acompanhamento Terapêutico", "Suporte contínuo em fases de transição, luto, ansiedade e processos de mudança."],
   ["Práticas Integrativas", "Técnicas complementares de relaxamento e equilíbrio emocional, integradas ao seu plano de cuidado."]]
    .forEach((s, i) => db.prepare("INSERT INTO services(title,text,sort) VALUES(?,?,?)").run(s[0], s[1], i));

  [["Recepção", "Chegue e sinta-se em casa", "https://images.unsplash.com/photo-1631217868264-e5b90bb7e133?auto=format&fit=crop&w=700&q=70"],
   ["Sala de atendimento", "Conforto e privacidade", "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=700&q=70"],
   ["Sala de ozonioterapia", "Equipamentos certificados", "https://images.unsplash.com/photo-1629909613654-28e377c37b09?auto=format&fit=crop&w=700&q=70"],
   ["Ambiente zen", "Detalhes que acolhem", "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=700&q=70"],
   ["Bem-estar integral", "Cuidado com corpo e mente", "https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=700&q=70"],
   ["Atendimento online", "Perto de você, em qualquer lugar", "https://images.unsplash.com/photo-1609220136736-443140cffec6?auto=format&fit=crop&w=700&q=70"]]
    .forEach((w, i) => db.prepare("INSERT INTO portfolio(title,subtitle,image,sort) VALUES(?,?,?,?)").run(w[0], w[1], w[2], i));

  [["Encontrei um espaço onde posso falar sem medo de julgamento. A análise mudou a forma como eu me relaciono comigo mesma.", "Mariana F.", "Psicanálise · Caruaru", "MF"],
   ["Faço as sessões online de Portugal e o cuidado é o mesmo de estar aí. Pontualidade e acolhimento impecáveis.", "Ricardo A.", "Atendimento online · Lisboa", "RA"],
   ["A ozonioterapia me devolveu a disposição. Equipe atenciosa e espaço impecável do início ao fim.", "Dona Lúcia", "Ozonioterapia · Toritama", "DL"]]
    .forEach((d, i) => db.prepare("INSERT INTO testimonials(text,name,role,initials,sort) VALUES(?,?,?,?,?)").run(d[0], d[1], d[2], d[3], i));

  console.log("· Banco inicializado. Senha do painel: bemestar-admin");
}
seed();
// migração leve: garante chaves novas em bancos já existentes
if (!getS("cnpj")) setS("cnpj", "00.000.000/0001-00");
// migração leve: semeia a equipe em bancos criados antes da seção Profissionais
if (db.prepare("SELECT COUNT(*) AS c FROM team").get().c === 0) {
  [["Dra. Ana Beltrão", "Psicanalista clínica", "Mais de 10 anos de escuta clínica, com especialização em ansiedade, luto e relações familiares. Atende adultos e adolescentes, presencial e online.", "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=600&q=75"],
   ["Dr. Henrique Vasconcelos", "Médico · Ozonioterapia", "Médico com formação em práticas integrativas e ozonioterapia. Conduz os protocolos da clínica com segurança, técnica e acompanhamento próximo.", "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?auto=format&fit=crop&w=600&q=75"],
   ["Camila Rocha", "Terapeuta integrativa", "Especialista em práticas integrativas e técnicas de relaxamento, apoia os planos de cuidado com sessões que unem corpo e mente.", "https://images.unsplash.com/photo-1607746882042-944635dfe10e?auto=format&fit=crop&w=600&q=75"]]
    .forEach((m, i) => db.prepare("INSERT INTO team(name,role,bio,photo,sort) VALUES(?,?,?,?,?)").run(m[0], m[1], m[2], m[3], i));
}

/* ------------------------------ Sessões ---------------------------------- */
const sessions = new Map();
const authed = (req) => { const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || ""); return m && sessions.has(m[1]); };

/* ------------------------------ Publicar --------------------------------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ICONS = [
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a7 7 0 0 1 7 7c0 1.9-.7 3.2-1.7 4.5-.8 1-1.3 2.1-1.3 3.5v3h-6v-2H8a2 2 0 0 1-2-2v-3H4.5L6.2 10A7 7 0 0 1 12 3Z"/><path d="M11 9.5a1.8 1.8 0 1 1 1.8 1.8V13"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/><path d="M9 14a3 3 0 0 0 3 3"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.8 14.6A5.4 5.4 0 0 1 21 20"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12.6 12 20l-7.5-7.4a5 5 0 1 1 7.5-6.3 5 5 0 1 1 7.5 6.3Z"/><path d="M6 12h3l1.5-2 2 3.5L14 12h4"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20c-5.5 0-8-3.5-8-8 5.5 0 8 3.5 8 8Z"/><path d="M12 20c5.5 0 8-3.5 8-8-5.5 0-8 3.5-8 8Z"/><path d="M12 12c1.6-2.2 1.6-4.8 0-7-1.6 2.2-1.6 4.8 0 7Z"/></svg>',
];
const CHECK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function setMarker(html, key, content) {
  const re = new RegExp(`(<!--#${key}-->)[\\s\\S]*?(<!--\\/${key}-->)`);
  if (!re.test(html)) throw new Error(`Marcador ${key} não encontrado`);
  // replacement em função: evita que "$" no conteúdo seja interpretado ($$, $1…)
  return html.replace(re, (_m, open, close) => `${open}\n${content}\n${close}`);
}

function publish() {
  const S = {}; for (const r of db.prepare("SELECT key,value FROM settings").all()) S[r.key] = r.value;
  const services = db.prepare("SELECT * FROM services ORDER BY sort,id").all();
  const works = db.prepare("SELECT * FROM portfolio ORDER BY sort,id").all();
  const deps = db.prepare("SELECT * FROM testimonials ORDER BY sort,id").all();
  const team = db.prepare("SELECT * FROM team ORDER BY sort,id").all();

  const stats = JSON.parse(S.stats || "[]").map((s) =>
    `<div class="stat"><dd class="stat__num">${esc(s.num)}</dd><dt class="stat__label">${esc(s.label)}</dt></div>`).join("\n            ");

  const servicesHtml = services.map((s, i) => `<article class="card" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <div class="service__icon">${ICONS[i % ICONS.length]}</div>
            <h3 class="service__title">${esc(s.title)}</h3>
            <p class="service__text">${esc(s.text)}</p>
          </article>`).join("\n          ");

  const worksHtml = works.map((w, i) => `<figure class="work" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}><img src="${esc(w.image)}" alt="${esc(w.title)} — BemEstarClinic" loading="lazy"><figcaption class="work__label">${esc(w.title)}<small>${esc(w.subtitle || "")}</small></figcaption></figure>`).join("\n          ");

  const bullets = JSON.parse(S.about_bullets || "[]").map((b) => `<li>${CHECK} ${esc(b)}</li>`).join("\n            ");

  const teamHtml = team.map((m, i) => `<article class="card pro" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <figure class="pro__photo"><img src="${esc(m.photo)}" alt="${esc(m.name)} — ${esc(m.role)}" loading="lazy" width="300" height="340"></figure>
            <h3 class="pro__name">${esc(m.name)}</h3>
            <p class="pro__role">${esc(m.role)}</p>
            <p class="pro__bio">${esc(m.bio)}</p>
          </article>`).join("\n          ");

  const depsHtml = deps.map((t, i) => `<figure class="card quote" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <div class="quote__stars" aria-label="5 de 5">★★★★★</div>
            <blockquote class="quote__text">“${esc(t.text)}”</blockquote>
            <figcaption class="quote__author"><span class="avatar">${esc(t.initials)}</span><span><span class="quote__name">${esc(t.name)}</span><br><span class="quote__role">${esc(t.role)}</span></span></figcaption>
          </figure>`).join("\n          ");

  const contactInfo = `<a class="contact-tile" href="https://wa.me/${esc(S.whatsapp)}" target="_blank" rel="noopener">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.6A8.5 8.5 0 1 1 21 11.5Z"/></svg></span>
              <span><span class="contact-tile__label">WhatsApp — resposta rápida</span><br><span class="contact-tile__value">${esc(S.whatsapp_display)}</span></span>
            </a>
            <a class="contact-tile" href="mailto:${esc(S.contact_email)}">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></span>
              <span><span class="contact-tile__label">E-mail</span><br><span class="contact-tile__value">${esc(S.contact_email)}</span></span>
            </a>
            <a class="contact-tile" href="https://www.instagram.com/${esc(S.instagram)}/" target="_blank" rel="noopener">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg></span>
              <span><span class="contact-tile__label">Instagram</span><br><span class="contact-tile__value">@${esc(S.instagram)}</span></span>
            </a>`;

  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", "@id": "https://bemestarclinic.com.br/#org", name: "BemEstarClinic",
      url: "https://bemestarclinic.com.br/", logo: "https://bemestarclinic.com.br/assets/img/mark.svg",
      email: S.contact_email, sameAs: [`https://www.instagram.com/${S.instagram}/`] },
    { "@type": "MedicalClinic", "@id": "https://bemestarclinic.com.br/#clinica", name: "BemEstarClinic",
      image: "https://bemestarclinic.com.br/assets/img/og-image.png", url: "https://bemestarclinic.com.br/",
      description: "Clínica de psicanálise, ozonioterapia e terapias integrativas em Caruaru-PE, com atendimento online para o mundo todo.",
      telephone: "+" + S.whatsapp,
      address: { "@type": "PostalAddress", addressLocality: "Caruaru", addressRegion: "PE", addressCountry: "BR" },
      areaServed: ["Caruaru e região", "Atendimento online — mundo todo"], priceRange: "$$",
      availableService: services.map((s) => ({ "@type": "MedicalTherapy", name: s.title })),
      parentOrganization: { "@id": "https://bemestarclinic.com.br/#org" } },
    { "@type": "WebSite", url: "https://bemestarclinic.com.br/", name: "BemEstarClinic", inLanguage: "pt-BR",
      publisher: { "@id": "https://bemestarclinic.com.br/#org" } },
  ] };
  const jsonldHtml = `<script type="application/ld+json">\n  ${JSON.stringify(jsonld, null, 2).replace(/\n/g, "\n  ")}\n  </script>`;

  const idx = path.join(ROOT, "index.html");
  let html = fs.readFileSync(idx, "utf8");
  html = setMarker(html, "JSONLD", "  " + jsonldHtml);
  html = setMarker(html, "HERO_BADGE", S.hero_badge);
  html = setMarker(html, "HERO_TITLE", S.hero_title);
  html = setMarker(html, "HERO_LEAD", S.hero_lead);
  html = setMarker(html, "STATS", "            " + stats);
  html = setMarker(html, "SERVICES", "          " + servicesHtml);
  html = setMarker(html, "ABOUT_TITLE", S.about_title);
  html = setMarker(html, "ABOUT_LEAD", S.about_lead);
  html = setMarker(html, "ABOUT_BULLETS", "            " + bullets);
  html = setMarker(html, "TEAM", "          " + teamHtml);
  html = setMarker(html, "PORTFOLIO", "          " + worksHtml);
  html = setMarker(html, "TESTIMONIALS", "          " + depsHtml);
  html = setMarker(html, "CONTACT_INFO", "            " + contactInfo);
  html = setMarker(html, "FOOTER_TAGLINE", S.footer_tagline);
  html = setMarker(html, "CNPJ", S.cnpj);
  // atualiza QUALQUER wa.me/<numero> restante (footer etc.)
  html = html.replace(/wa\.me\/\d+/g, `wa.me/${S.whatsapp}`);
  fs.writeFileSync(idx, html);

  // config.js
  const cfgPath = path.join(ROOT, "assets/js/config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/WHATSAPP_NUMBER = "[^"]*"/, `WHATSAPP_NUMBER = "${S.whatsapp}"`)
           .replace(/CONTACT_EMAIL = "[^"]*"/, `CONTACT_EMAIL = "${S.contact_email}"`);
  fs.writeFileSync(cfgPath, cfg);
  return { services: services.length, works: works.length, team: team.length };
}

/* ------------------------------ HTTP util --------------------------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, bad) => {
  let d = "", n = 0;
  req.on("data", (c) => { n += c.length; if (n > 25e6) { bad(new Error("payload muito grande")); req.destroy(); } d += c; });
  req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error("JSON inválido")); } });
});
const TABLES = { services: ["title", "text", "sort"], portfolio: ["title", "subtitle", "image", "sort"], testimonials: ["text", "name", "role", "initials", "sort"], team: ["name", "role", "bio", "photo", "sort"] };
const KEYS = ["hero_badge", "hero_title", "hero_lead", "stats", "about_title", "about_lead", "about_bullets",
  "whatsapp", "whatsapp_display", "contact_email", "instagram", "footer_tagline", "cnpj"];
const slug = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* ------------------------------ Servidor ---------------------------------- */
http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  try {
    if (p.startsWith("/api/")) {
      if (p === "/api/login" && req.method === "POST") {
        const { password } = await readBody(req);
        if (sha(password) !== getS("admin_password_hash")) return json(res, 401, { error: "Senha incorreta" });
        const t = crypto.randomBytes(24).toString("hex");
        sessions.set(t, Date.now());
        res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; Path=/; SameSite=Lax`);
        return json(res, 200, { ok: true });
      }
      if (!authed(req)) return json(res, 401, { error: "Não autenticado" });
      if (p === "/api/me") return json(res, 200, { ok: true });
      if (p === "/api/logout" && req.method === "POST") {
        const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ""); if (m) sessions.delete(m[1]);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/password" && req.method === "POST") {
        const { current, next } = await readBody(req);
        if (sha(current) !== getS("admin_password_hash")) return json(res, 400, { error: "Senha atual incorreta" });
        if (!next || String(next).length < 6) return json(res, 400, { error: "Nova senha deve ter 6+ caracteres" });
        setS("admin_password_hash", sha(next));
        return json(res, 200, { ok: true });
      }
      if (p === "/api/content") {
        const S = {}; for (const k of KEYS) S[k] = getS(k) || "";
        return json(res, 200, {
          settings: S,
          services: db.prepare("SELECT * FROM services ORDER BY sort,id").all(),
          portfolio: db.prepare("SELECT * FROM portfolio ORDER BY sort,id").all(),
          testimonials: db.prepare("SELECT * FROM testimonials ORDER BY sort,id").all(),
          team: db.prepare("SELECT * FROM team ORDER BY sort,id").all(),
        });
      }
      if (p === "/api/settings" && req.method === "PUT") {
        const b = await readBody(req);
        for (const [k, v] of Object.entries(b)) if (KEYS.includes(k)) setS(k, v);
        return json(res, 200, { ok: true });
      }
      const tm = p.match(/^\/api\/(services|portfolio|testimonials|team)(?:\/(\d+))?$/);
      if (tm) {
        const table = tm[1], id = tm[2], cols = TABLES[table];
        if (req.method === "POST" && !id) {
          const b = await readBody(req);
          const use = cols.filter((c) => c in b);
          db.prepare(`INSERT INTO ${table}(${use.join(",")}) VALUES(${use.map(() => "?").join(",")})`).run(...use.map((c) => b[c]));
          return json(res, 200, { ok: true });
        }
        if (req.method === "PUT" && id) {
          const b = await readBody(req);
          const use = cols.filter((c) => c in b);
          if (use.length) db.prepare(`UPDATE ${table} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`).run(...use.map((c) => b[c]), id);
          return json(res, 200, { ok: true });
        }
        if (req.method === "DELETE" && id) {
          db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
          return json(res, 200, { ok: true });
        }
      }
      if (p === "/api/upload" && req.method === "POST") {
        const { name, dataUrl } = await readBody(req);
        const m = /^data:(image\/(?:png|jpe?g|webp|svg\+xml|gif));base64,(.+)$/.exec(dataUrl || "");
        if (!m) return json(res, 400, { error: "Envie uma imagem (png, jpg, webp, svg ou gif)" });
        const safe = slug(path.parse(name || "foto").name).slice(0, 40) || "foto";
        const ext = m[1] === "image/svg+xml" ? ".svg" : "." + m[1].split("/")[1].replace("jpeg", "jpg");
        const file = `${Date.now().toString(36)}-${safe}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
        return json(res, 200, { ok: true, path: `/assets/img/uploads/${file}` });
      }
      if (p === "/api/publish" && req.method === "POST") return json(res, 200, { ok: true, ...publish() });
      return json(res, 404, { error: "Rota não encontrada" });
    }

    if (p === "/admin" || p === "/admin/") {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(fs.readFileSync(path.join(ROOT, "admin", "index.html")));
    }
    if (/^\/(data|server\.js)(\/|$)/.test(p)) { res.writeHead(404); return res.end("404"); }

    let file = path.normalize(path.join(ROOT, decodeURIComponent(p)));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("403"); }
    if (p === "/") file = path.join(ROOT, "index.html");
    else if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } catch (e) { json(res, 500, { error: e.message }); }
}).listen(PORT, () => {
  console.log(`\n  BemEstarClinic — site + gerenciador`);
  console.log(`  · Site:   http://localhost:${PORT}/`);
  console.log(`  · Painel: http://localhost:${PORT}/admin/  (senha inicial: bemestar-admin)\n`);
});
