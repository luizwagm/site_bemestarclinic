/* ==========================================================================
   main.js — BemEstarClinic · interações leves
   Header no scroll · menu mobile · reveal · form → WhatsApp · FAB WhatsApp
   ========================================================================== */
import { WHATSAPP_NUMBER, GA4_ID, GTM_ID, META_PIXEL_ID, CLARITY_ID, HOTJAR_ID } from "./config.js";

const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];

function initHeader() {
  const h = $(".site-header");
  if (!h) return;
  const on = () => h.classList.toggle("is-scrolled", window.scrollY > 8);
  on();
  window.addEventListener("scroll", on, { passive: true });
}

function initMobileNav() {
  const t = $(".nav-toggle"), nav = $("#primary-nav");
  if (!t || !nav) return;
  const set = (o) => { nav.classList.toggle("is-open", o); t.setAttribute("aria-expanded", String(o)); };
  t.addEventListener("click", () => set(t.getAttribute("aria-expanded") !== "true"));
  $$("a", nav).forEach((a) => a.addEventListener("click", () => set(false)));
}

function initReveal() {
  const els = $$("[data-reveal]");
  if (!("IntersectionObserver" in window)) return els.forEach((e) => e.classList.add("is-visible"));
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
  }), { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  els.forEach((e) => io.observe(e));
}

let toastT;
function toast(msg) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add("is-visible"));
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove("is-visible"), 2800);
}

function initForm() {
  const form = $("#lead-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = Object.fromEntries(new FormData(form).entries());
    const msg = encodeURIComponent(
      `*Agendamento — BemEstarClinic* 🪷\n\nNome: ${d.nome}\nServiço: ${d.servico}\nModalidade: ${d.modalidade}\n\nMensagem:\n${d.mensagem || "-"}\n\nWhatsApp: ${d.whatsapp}`
    );
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`, "_blank", "noopener");
    toast("Abrindo o WhatsApp com o seu pedido de agendamento…");
    form.reset();
  });
}

function initFab() {
  if ($(".wa-fab")) return;
  const msg = encodeURIComponent("Olá! Vim pelo site da BemEstarClinic e gostaria de agendar uma consulta. 🪷");
  const a = document.createElement("a");
  a.className = "wa-fab";
  a.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`;
  a.target = "_blank"; a.rel = "noopener";
  a.setAttribute("aria-label", "Falar no WhatsApp");
  a.innerHTML = `<svg class="wa-fab__icon" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M16 3C9 3 3.5 8.5 3.5 15.5c0 2.4.7 4.7 1.9 6.7L4 29l7-1.8c1.9 1 4 1.6 6 1.6 7 0 12.5-5.5 12.5-12.5S23 3 16 3Zm0 22.7c-1.8 0-3.6-.5-5.2-1.4l-.4-.2-4.1 1.1 1.1-4-.2-.4a10 10 0 0 1-1.6-5.4C5.6 9.7 10.3 5 16 5s10.4 4.7 10.4 10.5S21.7 25.7 16 25.7Zm5.7-7.8c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.2 8.2 0 0 1-2.4-1.5 9 9 0 0 1-1.7-2.1c-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.3c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.4-1.2 1.2-1.2 2.9s1.2 3.4 1.4 3.6c.2.2 2.4 3.7 5.8 5.1.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 2-.8 2.2-1.6.3-.8.3-1.4.2-1.6l-.6-.3Z"/></svg>`;
  document.body.appendChild(a);
}

/* Formulário de agendamento (/agendar/) → monta a mensagem e envia ao WhatsApp */
function initAgendarForm() {
  const form = $("#agendar-form");
  if (!form) return;

  /* veio de uma especialidade (/agendar/?esp=…) → já chega selecionada */
  const esp = new URLSearchParams(location.search).get("esp");
  const sel = $("#a-esp");
  if (esp && sel) {
    const alvo = [...sel.options].find((o) => o.text.trim() === esp.trim());
    if (alvo) sel.value = alvo.value || alvo.text;
  }

  const refWrap = $("#ref-quem-wrap");
  const refInput = $("#a-quem");
  if (refWrap) {
    form.addEventListener("change", (e) => {
      if (e.target.name === "indicacao") {
        const sim = e.target.value === "sim";
        refWrap.hidden = !sim;
        if (refInput) refInput.required = sim;   // obrigatório só quando "Sim"
      }
    });
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = Object.fromEntries(new FormData(form).entries());
    const L = (label, v) => (v && String(v).trim() ? `${label}: ${String(v).trim()}\n` : "");
    const indic = d.indicacao === "sim"
      ? `Sim${d.indicacao_quem ? ` — ${d.indicacao_quem}` : ""}`
      : (d.indicacao === "nao" ? "Não" : "");
    const msg =
      `*Cadastro de Paciente — BemEstarClinic* 🪷\n\n` +
      `*🏥 Dados do Paciente*\n` +
      L("🔹 Especialidade", d.especialidade) +
      L("🔹 Nome completo", d.nome) +
      L("🔹 Data de nascimento", d.nascimento) +
      L("🔹 Profissão", d.profissao) +
      L("🔹 CPF", d.cpf) +
      L("🔹 Estado civil", d.estado_civil) +
      L("🔹 Nome da mãe", d.mae) +
      L("🔹 Nome do pai", d.pai) +
      `\n*🏡 Endereço e Contato*\n` +
      L("📍 Endereço", d.endereco) +
      L("📞 Telefone", d.telefone) +
      L("📞 Emergência", d.emergencia) +
      L("📷 Instagram", d.instagram) +
      `\n*🗣️ Informações Adicionais*\n` +
      L("❓ Indicação", indic) +
      L("📝 Sintomas/queixas", d.sintomas);
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
    toast("Abrindo o WhatsApp com o seu cadastro…");
  });
}

/* ==========================================================================
   Consentimento de cookies (LGPD)
   Hoje o site não grava nenhum cookie por conta própria. O banner existe para
   controlar os scripts de medição (GA4/GTM/Pixel/Clarity/Hotjar): eles SÓ são
   carregados depois do "Aceitar". Sem consentimento, nada de terceiros roda —
   é o consentimento prévio que a LGPD exige, e não o aviso decorativo.
   ========================================================================== */
const CONSENT_COOKIE = "bec_consent";
const CONSENT_DIAS = 180;

const lerConsent = () =>
  (new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE}=(aceito|essenciais)`).exec(document.cookie) || [])[1] || null;

function gravarConsent(valor) {
  const seguro = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${valor}; Max-Age=${CONSENT_DIAS * 86400}; Path=/; SameSite=Lax${seguro}`;
}

/* Injeta os scripts de medição — só chamado com consentimento explícito */
let medicaoCarregada = false;
function carregarMedicao() {
  if (medicaoCarregada) return;
  medicaoCarregada = true;
  const script = (src, attrs = {}) => {
    const s = document.createElement("script");
    s.async = true; s.src = src;
    Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
    document.head.appendChild(s);
  };
  const inline = (code) => {
    const s = document.createElement("script");
    s.textContent = code;
    document.head.appendChild(s);
  };

  if (GA4_ID) {
    script(`https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`);
    inline(`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
      gtag('js',new Date());gtag('config','${GA4_ID}',{anonymize_ip:true});`);
  }
  if (GTM_ID) {
    inline(`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});
      var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';
      j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
      })(window,document,'script','dataLayer','${GTM_ID}');`);
  }
  if (META_PIXEL_ID) {
    inline(`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
      n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script',
      'https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');`);
  }
  if (CLARITY_ID) {
    inline(`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");`);
  }
  if (HOTJAR_ID) {
    inline(`(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};
      h._hjSettings={hjid:${HOTJAR_ID},hjsv:6};a=o.getElementsByTagName('head')[0];
      r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j;a.appendChild(r);
      })(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`);
  }
}

function montarBanner() {
  if ($(".cookie-bar")) return;
  const bar = document.createElement("div");
  bar.className = "cookie-bar";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-live", "polite");
  bar.setAttribute("aria-label", "Aviso sobre cookies");
  bar.innerHTML = `
    <div class="cookie-bar__text">
      <b>A gente usa cookies. 🍪</b>
      <p>Alguns são necessários para o site funcionar. Com a sua autorização, usamos também cookies de medição — só para entender como as pessoas chegam até a clínica e melhorar o site. Nada do que você conversa em consulta passa por aqui. <a href="/privacidade/">Ler a Política de Privacidade</a>.</p>
    </div>
    <div class="cookie-bar__acoes">
      <button type="button" class="btn btn--ghost btn--sm" data-consent="essenciais">Só os essenciais</button>
      <button type="button" class="btn btn--primary btn--sm" data-consent="aceito">Aceitar cookies</button>
    </div>`;
  document.body.appendChild(bar);

  // o FAB do WhatsApp é criado ANTES do banner, então seletor de irmão não pega:
  // marcamos o body e publicamos a altura real do aviso para o CSS subir o botão.
  const marcarAltura = () => {
    document.body.classList.add("has-cookie-bar");
    document.body.style.setProperty("--cookie-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  };
  marcarAltura();
  window.addEventListener("resize", marcarAltura);
  requestAnimationFrame(() => bar.classList.add("is-open"));

  bar.addEventListener("click", (e) => {
    const escolha = e.target.closest("[data-consent]")?.dataset.consent;
    if (!escolha) return;
    gravarConsent(escolha);
    if (escolha === "aceito") carregarMedicao();
    bar.classList.remove("is-open");
    document.body.classList.remove("has-cookie-bar");
    window.removeEventListener("resize", marcarAltura);
    setTimeout(() => bar.remove(), 350);
    toast(escolha === "aceito" ? "Preferência salva. Obrigado! 🪷" : "Certo — só os cookies essenciais.");
  });
}

/* Links legais no rodapé de TODAS as páginas — injetados aqui para não precisar
   editar os 9 templates. A LGPD exige que rever a escolha seja tão fácil quanto fazê-la. */
function linksRodape() {
  const alvo = $(".footer__bottom p") || $(".footer__bottom");
  if (!alvo || $(".cookie-prefs")) return;

  if (!alvo.querySelector('a[href="/privacidade/"]') && location.pathname !== "/privacidade/") {
    const p = document.createElement("a");
    p.href = "/privacidade/";
    p.textContent = "Privacidade";
    alvo.append(" · ", p);
  }

  const a = document.createElement("button");
  a.type = "button";
  a.className = "cookie-prefs";
  a.textContent = "Preferências de cookies";
  a.addEventListener("click", () => {
    document.cookie = `${CONSENT_COOKIE}=; Max-Age=0; Path=/`;
    montarBanner();
  });
  alvo.append(" · ", a);
}

function initConsent() {
  linksRodape();
  const escolha = lerConsent();
  if (!escolha) montarBanner();
  else if (escolha === "aceito") carregarMedicao();
}

function initYear() { const y = $("#year"); if (y) y.textContent = new Date().getFullYear(); }

/* Lupa no topo → abre campo → leva para /busca/?q= */
function initHeaderSearch() {
  const inner = $(".site-header .header__inner");
  if (!inner || $(".search-toggle")) return;

  const btn = document.createElement("button");
  btn.className = "search-toggle";
  btn.type = "button";
  btn.setAttribute("aria-label", "Pesquisar no site");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;

  const bar = document.createElement("div");
  bar.className = "site-search";
  bar.innerHTML = `
    <form class="site-search__form" role="search" action="/busca/" method="get">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="search" name="q" class="site-search__input" placeholder="Busque especialidades, artigos, profissionais…" autocomplete="off" aria-label="Buscar no site">
      <button type="submit" class="site-search__go">Buscar</button>
      <button type="button" class="site-search__close" aria-label="Fechar busca">✕</button>
    </form>`;

  const navToggle = $(".nav-toggle", inner);
  inner.insertBefore(btn, navToggle || null);
  $(".site-header").appendChild(bar);

  const input = $(".site-search__input", bar);
  const open = () => { bar.classList.add("is-open"); btn.setAttribute("aria-expanded", "true"); setTimeout(() => input.focus(), 60); };
  const close = () => { bar.classList.remove("is-open"); btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", () => bar.classList.contains("is-open") ? close() : open());
  $(".site-search__close", bar).addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  $(".site-search__form", bar).addEventListener("submit", (e) => {
    if (!input.value.trim()) { e.preventDefault(); input.focus(); }
  });
}

/* Página /busca/: lê ?q=, filtra o índice e renderiza */
async function initSearchResults() {
  const results = $("#busca-results");
  if (!results) return;
  const status = $("#busca-status");
  const form = $("#busca-form"), input = $("#busca-input");
  const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const q = new URLSearchParams(location.search).get("q") || "";
  input.value = q;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const nq = input.value.trim();
    location.href = "/busca/" + (nq ? "?q=" + encodeURIComponent(nq) : "");
  });

  if (!q.trim()) { status.textContent = "Digite um termo para buscar."; return; }
  document.title = `Busca: ${q} — BemEstarClinic`;

  let data = [];
  try { data = await (await fetch("/assets/data/search-index.json")).json(); }
  catch { status.textContent = "Não foi possível carregar a busca agora."; return; }

  const terms = norm(q).split(/\s+/).filter(Boolean);
  const scored = data.map((it) => {
    const hayT = norm(it.t), hayD = norm(it.d);
    let score = 0;
    for (const term of terms) {
      if (hayT.includes(term)) score += 10;
      if (hayD.includes(term)) score += 3;
    }
    return { it, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  status.textContent = scored.length
    ? `${scored.length} resultado${scored.length > 1 ? "s" : ""} para “${q}”.`
    : `Nenhum resultado para “${q}”. Tente outro termo — ou fale com a gente no WhatsApp.`;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const highlight = (text) => {
    let t = esc(text.slice(0, 180));
    terms.forEach((term) => { t = t.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>"); });
    return t;
  };

  results.innerHTML = scored.map(({ it }) => `
    <a class="busca-item" href="${esc(it.u)}">
      <span class="busca-item__tag">${esc(it.tipo)}</span>
      <h3 class="busca-item__title">${esc(it.t)}</h3>
      <p class="busca-item__desc">${highlight(it.d)}…</p>
    </a>`).join("");
}

function boot() { initHeader(); initMobileNav(); initHeaderSearch(); initReveal(); initForm(); initFab(); initYear(); initSearchResults(); initAgendarForm(); initConsent(); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
