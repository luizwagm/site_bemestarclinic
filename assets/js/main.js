/* ==========================================================================
   main.js — BemEstarClinic · interações leves
   Header no scroll · menu mobile · reveal · form → WhatsApp · FAB WhatsApp
   ========================================================================== */
import { WHATSAPP_NUMBER } from "./config.js";

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
  a.setAttribute("aria-label", "Agendar pelo WhatsApp");
  a.innerHTML = `<svg class="wa-fab__icon" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M16 3C9 3 3.5 8.5 3.5 15.5c0 2.4.7 4.7 1.9 6.7L4 29l7-1.8c1.9 1 4 1.6 6 1.6 7 0 12.5-5.5 12.5-12.5S23 3 16 3Zm0 22.7c-1.8 0-3.6-.5-5.2-1.4l-.4-.2-4.1 1.1 1.1-4-.2-.4a10 10 0 0 1-1.6-5.4C5.6 9.7 10.3 5 16 5s10.4 4.7 10.4 10.5S21.7 25.7 16 25.7Zm5.7-7.8c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.2 8.2 0 0 1-2.4-1.5 9 9 0 0 1-1.7-2.1c-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.3c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.4-1.2 1.2-1.2 2.9s1.2 3.4 1.4 3.6c.2.2 2.4 3.7 5.8 5.1.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 2-.8 2.2-1.6.3-.8.3-1.4.2-1.6l-.6-.3Z"/></svg><span class="wa-fab__label">Agendar consulta</span>`;
  document.body.appendChild(a);
}

function initYear() { const y = $("#year"); if (y) y.textContent = new Date().getFullYear(); }

function boot() { initHeader(); initMobileNav(); initReveal(); initForm(); initFab(); initYear(); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
