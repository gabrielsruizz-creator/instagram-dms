"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  folder: "inbox",
  threads: { inbox: [], pending: [] },
  cursors: { inbox: null, pending: null },
  done: { inbox: false, pending: false },
  loading: false,
  loadError: null,
  selected: new Set(),
  visible: [],
  lastClickedIndex: null,
  removedByJob: new Set(),
};

// ------------------------------------------------------------------ API ---

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    init.method = options.method || "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch (_) { /* sem corpo */ }
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- Telas ---

function show(screen) {
  for (const s of $$(".screen")) s.hidden = s.id !== `screen-${screen}`;
}

function toast(msg, ms = 4000) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function showError(el, msg) {
  el.textContent = msg || "";
  el.hidden = !msg;
}

// -------------------------------------------------------------- Login ---

async function waitForLogin() {
  // Fica consultando o servidor até o login sair do estado "working".
  for (;;) {
    const { login, job } = await api("/api/status");
    if (login.status === "working") {
      show("loading");
      $("#loading-text").textContent = login.username ? `Entrando como @${login.username}…` : "Conectando…";
      await sleep(800);
      continue;
    }
    routeLogin(login, job);
    return login;
  }
}

function routeLogin(login, job) {
  if (login.status === "logged_in") {
    $("#me-username").textContent = `@${login.username}`;
    show("app");
    if (!state.threads.inbox.length && !state.loading) loadAll();
    if (job && job.status === "running") watchJob();
  } else if (login.status === "need_2fa" || login.status === "need_challenge") {
    const help = login.status === "need_2fa"
      ? "Sua conta tem verificação em duas etapas. Digite o código do app autenticador ou o que chegou por SMS."
      : `O Instagram enviou um código de segurança por ${login.challenge === "sms" ? "SMS" : "e-mail"}. Digite aqui.`;
    $("#code-help").textContent = help;
    $("#code-form").reset();
    show("code");
    $("#code-form input").focus();
  } else {
    show("login");
    showError($("#login-error"), login.error);
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button");
  btn.disabled = true;
  showError($("#login-error"), null);
  try {
    await api("/api/login", {
      body: { username: form.username.value, password: form.password.value },
    });
    form.password.value = "";
    await waitForLogin();
  } catch (err) {
    showError($("#login-error"), err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button");
  btn.disabled = true;
  showError($("#code-error"), null);
  try {
    await api("/api/login/code", { body: { code: form.code.value } });
    await sleep(500);
    await waitForLogin();
  } catch (err) {
    showError($("#code-error"), err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  if (!confirm("Sair da conta? O login salvo neste computador será apagado.")) return;
  try {
    await api("/api/logout", { body: {} });
    resetThreads();
    renderList();
    show("login");
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------- Conversas ---

function resetThreads() {
  state.threads = { inbox: [], pending: [] };
  state.cursors = { inbox: null, pending: null };
  state.done = { inbox: false, pending: false };
  state.selected.clear();
  state.loadError = null;
}

async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  state.loadError = null;
  renderList();
  updateLoadStatus();
  try {
    for (const folder of ["inbox", "pending"]) {
      while (!state.done[folder]) {
        const params = new URLSearchParams({ folder });
        if (state.cursors[folder]) params.set("cursor", state.cursors[folder]);
        const data = await api(`/api/threads?${params}`);
        const known = new Set(state.threads[folder].map((t) => t.id));
        for (const t of data.threads) {
          if (!known.has(t.id) && !state.removedByJob.has(t.id)) state.threads[folder].push(t);
        }
        state.cursors[folder] = data.cursor;
        if (!data.cursor || !data.threads.length) state.done[folder] = true;
        updateLoadStatus();
      }
    }
  } catch (err) {
    state.loadError = err.message;
    if (err.status === 401) {
      await waitForLogin();
    } else {
      toast(err.message, 6000);
    }
  } finally {
    state.loading = false;
    renderList();
    updateLoadStatus();
  }
}

function updateLoadStatus() {
  const total = state.threads.inbox.length + state.threads.pending.length;
  const el = $("#load-status");
  const btn = $("#reload-btn");
  $("#loading-count").textContent = total;
  if (state.loading) {
    el.textContent = `Carregando… ${total} conversas`;
    btn.disabled = true;
  } else if (state.loadError) {
    el.textContent = `Parou em ${total} conversas.`;
    btn.textContent = "Continuar carregando";
    btn.disabled = false;
  } else {
    el.textContent = `${total} conversas carregadas`;
    btn.textContent = "Recarregar";
    btn.disabled = false;
  }
  $("#count-inbox").textContent = state.threads.inbox.length;
  $("#count-pending").textContent = state.threads.pending.length;
}

$("#reload-btn").addEventListener("click", () => {
  if (!state.loadError) {
    resetThreads();
    renderList();
  }
  loadAll();
});

// ----------------------------------------------------------- Filtros ---

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function filteredThreads() {
  const q = normalize($("#search").value.trim());
  const type = $("#filter-type").value;
  const ageDays = Number($("#filter-age").value);
  const last = $("#filter-last").value;
  const cutoff = ageDays ? Date.now() - ageDays * 86400000 : null;

  return state.threads[state.folder].filter((t) => {
    if (type === "single" && t.is_group) return false;
    if (type === "group" && !t.is_group) return false;
    if (cutoff && t.last_activity && new Date(t.last_activity).getTime() > cutoff) return false;
    if (last === "me" && t.last_from_me !== true) return false;
    if (last === "them" && t.last_from_me !== false) return false;
    if (q) {
      const hay = normalize([t.title, t.preview, ...t.users.map((u) => `${u.username} ${u.full_name}`)].join(" "));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

for (const el of ["#search", "#filter-type", "#filter-age", "#filter-last"]) {
  $(el).addEventListener("input", () => { state.lastClickedIndex = null; renderList(); });
}

for (const tab of $$(".tab")) {
  tab.addEventListener("click", () => {
    state.folder = tab.dataset.folder;
    state.lastClickedIndex = null;
    for (const t of $$(".tab")) t.classList.toggle("active", t === tab);
    renderList();
  });
}

// ------------------------------------------------------------ Lista ---

const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" });

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return "hoje";
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days} dias`;
  return dateFmt.format(d);
}

function avatarFor(t) {
  const el = document.createElement("div");
  el.className = "avatar";
  const initial = (t.title || "?").trim().charAt(0).toUpperCase();
  const pic = t.users.length === 1 ? t.users[0].pic : null;
  if (pic) {
    const img = document.createElement("img");
    img.src = pic;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => { el.textContent = initial; };
    el.appendChild(img);
  } else {
    el.textContent = t.is_group ? "👥" : initial;
  }
  return el;
}

function threadRow(t, index) {
  const li = document.createElement("li");
  li.className = "thread" + (state.selected.has(t.id) ? " selected" : "");
  li.dataset.index = index;

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(t.id);
  cb.tabIndex = -1;

  const main = document.createElement("div");
  main.className = "thread-main";
  const title = document.createElement("div");
  title.className = "thread-title";
  title.textContent = t.title;
  if (t.is_group) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = "grupo";
    title.appendChild(b);
  }
  if (t.users.length === 1 && t.users[0].full_name && t.users[0].full_name !== t.title) {
    const n = document.createElement("span");
    n.className = "muted small";
    n.textContent = ` · ${t.users[0].full_name}`;
    title.appendChild(n);
  }
  const sub = document.createElement("div");
  sub.className = "thread-sub";
  sub.textContent = (t.last_from_me ? "Você: " : "") + (t.preview || "");
  main.append(title, sub);

  const date = document.createElement("div");
  date.className = "thread-date";
  date.textContent = formatDate(t.last_activity);

  li.append(cb, avatarFor(t), main, date);
  return li;
}

function renderList() {
  // Enquanto carrega, mostra só o contador; a lista aparece inteira no final.
  $("#loading-panel").hidden = !state.loading;
  $("#thread-list").hidden = state.loading;
  $("#select-all").disabled = state.loading;
  state.visible = state.loading ? [] : filteredThreads();
  const list = $("#thread-list");
  const frag = document.createDocumentFragment();
  state.visible.forEach((t, i) => frag.appendChild(threadRow(t, i)));
  list.replaceChildren(frag);
  $("#empty").hidden = state.visible.length > 0 || state.loading;
  $("#visible-count").textContent = state.visible.length;
  updateSelectionUi();
}

function updateSelectionUi() {
  const n = state.selected.size;
  $("#selected-count").textContent = n;
  $("#actionbar").hidden = n === 0;
  const visSel = state.visible.filter((t) => state.selected.has(t.id)).length;
  const all = $("#select-all");
  all.checked = state.visible.length > 0 && visSel === state.visible.length;
  all.indeterminate = visSel > 0 && visSel < state.visible.length;
}

function setRowSelected(index, on) {
  const t = state.visible[index];
  if (!t) return;
  if (on) state.selected.add(t.id); else state.selected.delete(t.id);
  const li = $(`#thread-list > li[data-index="${index}"]`);
  if (li) {
    li.classList.toggle("selected", on);
    li.querySelector("input").checked = on;
  }
}

// Clique numa conversa marca/desmarca. Shift+clique marca um intervalo.
$("#thread-list").addEventListener("click", (e) => {
  const li = e.target.closest("li.thread");
  if (!li) return;
  const index = Number(li.dataset.index);
  const t = state.visible[index];
  const on = !state.selected.has(t.id);
  if (e.shiftKey && state.lastClickedIndex !== null) {
    const [a, b] = [state.lastClickedIndex, index].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) setRowSelected(i, on);
  } else {
    setRowSelected(index, on);
  }
  state.lastClickedIndex = index;
  updateSelectionUi();
});

$("#select-all").addEventListener("change", (e) => {
  for (let i = 0; i < state.visible.length; i++) setRowSelected(i, e.target.checked);
  updateSelectionUi();
});

$("#clear-selection").addEventListener("click", () => {
  state.selected.clear();
  renderList();
});

// ---------------------------------------------------------- Exclusão ---

function threadById(id) {
  return state.threads.inbox.find((t) => t.id === id) || state.threads.pending.find((t) => t.id === id);
}

$("#delete-btn").addEventListener("click", () => {
  const ids = [...state.selected];
  $("#confirm-count").textContent = ids.length;
  const preview = $("#confirm-preview");
  const items = ids.slice(0, 50).map((id) => {
    const li = document.createElement("li");
    li.textContent = threadById(id)?.title || id;
    return li;
  });
  if (ids.length > 50) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = `…e mais ${ids.length - 50}`;
    items.push(li);
  }
  preview.replaceChildren(...items);
  $("#confirm-dialog").showModal();
});

$("#confirm-dialog").addEventListener("close", async () => {
  if ($("#confirm-dialog").returnValue !== "ok") return;
  const ids = [...state.selected];
  try {
    await api("/api/delete", { body: { thread_ids: ids } });
    watchJob();
  } catch (err) {
    toast(err.message);
  }
});

function removeThreads(ids) {
  for (const id of ids) {
    state.removedByJob.add(id);
    state.selected.delete(id);
  }
  const gone = new Set(ids);
  for (const folder of ["inbox", "pending"]) {
    state.threads[folder] = state.threads[folder].filter((t) => !gone.has(t.id));
  }
}

let watching = false;

async function watchJob() {
  if (watching) return;
  watching = true;
  const dlg = $("#progress-dialog");
  $("#progress-title").textContent = "Excluindo…";
  $("#cancel-job").hidden = false;
  $("#cancel-job").disabled = false;
  $("#close-progress").hidden = true;
  $("#progress-errors").replaceChildren();
  $("#progress-hint").hidden = false;
  if (!dlg.open) dlg.showModal();

  let applied = 0;
  try {
    for (;;) {
      const { job } = await api("/api/status");
      if (!job) break;
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      $("#progress-fill").style.width = `${pct}%`;
      $("#progress-text").textContent = `${job.done} de ${job.total} (${job.deleted.length} excluídas)`;

      if (job.deleted.length > applied) {
        removeThreads(job.deleted.slice(applied));
        applied = job.deleted.length;
        renderList();
        updateLoadStatus();
      }

      if (job.status !== "running") {
        $("#progress-title").textContent =
          job.status === "finished" ? "Pronto!" : job.status === "cancelled" ? "Parado" : "Interrompido";
        $("#progress-text").textContent = job.message || "";
        $("#progress-hint").hidden = true;
        const errs = job.failed.map((f) => {
          const li = document.createElement("li");
          li.textContent = `${threadById(f.id)?.title || f.id}: ${f.error}`;
          return li;
        });
        $("#progress-errors").replaceChildren(...errs);
        break;
      }
      await sleep(1000);
    }
  } catch (err) {
    $("#progress-text").textContent = err.message;
  } finally {
    $("#cancel-job").hidden = true;
    $("#close-progress").hidden = false;
    watching = false;
  }
}

$("#cancel-job").addEventListener("click", async () => {
  $("#cancel-job").disabled = true;
  try { await api("/api/delete/cancel", { body: {} }); } catch (err) { toast(err.message); }
});

$("#close-progress").addEventListener("click", () => $("#progress-dialog").close());
// Não deixa fechar com Esc enquanto está excluindo.
$("#progress-dialog").addEventListener("cancel", (e) => { if (watching) e.preventDefault(); });

// ------------------------------------------------------------- Início ---

waitForLogin().catch((err) => {
  show("login");
  showError($("#login-error"), `Não foi possível falar com o servidor: ${err.message}`);
});
