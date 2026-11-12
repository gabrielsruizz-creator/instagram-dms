"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  section: "dms", // dms | nfb (não me seguem de volta) | fnb (não sigo de volta)
  delays: {},
  // Mensagens
  folder: "inbox",
  threads: { inbox: [], pending: [] },
  cursors: { inbox: null, pending: null },
  done: { inbox: false, pending: false },
  loading: false,
  loadError: null,
  removedByJob: new Set(),
  // Seguidores / seguindo
  people: emptyPeople(),
  // Análise do perfil
  analytics: emptyAnalytics(),
};

function emptyAnalytics() {
  return { tab: "summary", data: null, change: null, snapshotting: false, error: null, engagementRunning: false,
    engagementProgress: null, storiesLoading: false };
}

function emptyPeople() {
  return {
    followers: [],
    following: [],
    cursors: { followers: null, following: null },
    done: { followers: false, following: false },
    totals: { followers: null, following: null },
    loading: false,
    loadError: null,
    snapshotted: false,
  };
}

// Cada lista tem sua própria seleção.
const views = {
  dms: { list: "#thread-list", selectAll: "#select-all", selected: new Set(), visible: [], lastClickedIndex: null },
  nfb: { list: "#people-list", selectAll: "#people-select-all", selected: new Set(), visible: [], lastClickedIndex: null },
  fnb: { list: "#people-list", selectAll: "#people-select-all", selected: new Set(), visible: [], lastClickedIndex: null },
};
// Sub-abas da Análise
for (const key of ["summary", "unfollowers", "ghosts", "fans", "stories"]) {
  views[key] = {
    list: "#analysis-list", selectAll: "#analysis-select-all", selected: new Set(), visible: [], lastClickedIndex: null,
    static: !["unfollowers", "ghosts"].includes(key),
  };
}
const viewKey = () => (state.section === "analysis" ? state.analytics.tab : state.section);
const currentView = () => views[viewKey()];

// O que cada botão da barra de baixo faz.
const ACTIONS = {
  delete_threads: {
    button: "Excluir selecionadas",
    buttonClass: "danger",
    endpoint: "/api/delete",
    bodyKey: "thread_ids",
    title: (n) => `Excluir ${n} conversa(s)?`,
    text: "Elas somem da sua caixa de entrada (como no botão “Excluir conversa” do app). "
      + "A outra pessoa continua vendo a conversa. Isso não pode ser desfeito.",
    ok: "Sim, excluir",
    okClass: "danger",
    progress: "Excluindo…",
  },
  unfollow: {
    button: "Deixar de seguir",
    buttonClass: "danger",
    endpoint: "/api/people/action",
    bodyKey: "user_ids",
    title: (n) => `Deixar de seguir ${n} pessoa(s)?`,
    text: "Você para de seguir essas contas. Se alguma for privada, para seguir de novo vai precisar pedir outra vez.",
    ok: "Sim, deixar de seguir",
    okClass: "danger",
    progress: "Deixando de seguir…",
    risky: true,
  },
  remove_follower: {
    button: "Remover seguidor",
    buttonClass: "ghost",
    endpoint: "/api/people/action",
    bodyKey: "user_ids",
    title: (n) => `Remover ${n} seguidor(es)?`,
    text: "Essas pessoas deixam de te seguir. O Instagram não avisa elas.",
    ok: "Sim, remover",
    okClass: "danger",
    progress: "Removendo seguidores…",
    risky: true,
  },
  follow: {
    button: "Seguir de volta",
    buttonClass: "primary",
    endpoint: "/api/people/action",
    bodyKey: "user_ids",
    title: (n) => `Seguir ${n} pessoa(s) de volta?`,
    text: "Você passa a seguir essas contas. Nas privadas, vai um pedido para seguir.",
    ok: "Sim, seguir",
    okClass: "primary",
    progress: "Seguindo…",
    risky: true,
  },
};

const SECTION_ACTIONS = {
  dms: ["delete_threads"],
  nfb: ["unfollow"],
  fnb: ["remove_follower", "follow"],
  summary: [],
  unfollowers: ["unfollow"],
  ghosts: ["remove_follower"],
  fans: [],
  stories: [],
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

const numberFmt = new Intl.NumberFormat("pt-BR");
const fmt = (n) => numberFmt.format(n);

function formatDuration(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 1) return "menos de 1 minuto";
  if (min < 60) return `cerca de ${min} minuto(s)`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `cerca de ${h} h ${m} min` : `cerca de ${h} h`;
}

// -------------------------------------------------------------- Login ---

async function waitForLogin() {
  // Fica consultando o servidor até o login sair do estado "working".
  for (;;) {
    const { login, job, delays } = await api("/api/status");
    if (delays) state.delays = delays;
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
    if (state.section !== "dms" && !peopleReady() && !state.people.loading) loadPeople();
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
    state.people = emptyPeople();
    state.analytics = emptyAnalytics();
    for (const v of Object.values(views)) v.selected.clear();
    render();
    show("login");
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------- Seções ---

for (const tab of $$(".section-tab")) {
  tab.addEventListener("click", () => {
    state.section = tab.dataset.section;
    for (const t of $$(".section-tab")) t.classList.toggle("active", t === tab);
    $("#section-dms").hidden = state.section !== "dms";
    $("#section-people").hidden = !["nfb", "fnb"].includes(state.section);
    $("#section-analysis").hidden = state.section !== "analysis";
    if (state.section === "analysis") enterAnalysis();
    if (state.section !== "dms" && !peopleReady() && !state.people.loading && !state.people.loadError) loadPeople();
    render();
  });
}

function render() {
  if (state.section === "dms") renderDms();
  else if (state.section === "analysis") renderAnalysis();
  else renderPeople();
  renderActionBar();
}

// ---------------------------------------------------------- Conversas ---

function resetThreads() {
  state.threads = { inbox: [], pending: [] };
  state.cursors = { inbox: null, pending: null };
  state.done = { inbox: false, pending: false };
  views.dms.selected.clear();
  state.loadError = null;
}

async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  state.loadError = null;
  render();
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
    render();
    updateLoadStatus();
  }
}

function updateLoadStatus() {
  const total = state.threads.inbox.length + state.threads.pending.length;
  const el = $("#load-status");
  const btn = $("#reload-btn");
  $("#loading-count").textContent = fmt(total);
  if (state.loading) {
    el.textContent = `Carregando… ${fmt(total)} conversas`;
    btn.disabled = true;
  } else if (state.loadError) {
    el.textContent = `Parou em ${fmt(total)} conversas.`;
    btn.textContent = "Continuar carregando";
    btn.disabled = false;
  } else {
    el.textContent = `${fmt(total)} conversas carregadas`;
    btn.textContent = "Recarregar";
    btn.disabled = false;
  }
  $("#count-inbox").textContent = fmt(state.threads.inbox.length);
  $("#count-pending").textContent = fmt(state.threads.pending.length);
}

$("#reload-btn").addEventListener("click", () => {
  if (!state.loadError) {
    resetThreads();
    render();
  }
  loadAll();
});

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
  $(el).addEventListener("input", () => { views.dms.lastClickedIndex = null; render(); });
}

for (const tab of $$(".tab")) {
  tab.addEventListener("click", () => {
    state.folder = tab.dataset.folder;
    views.dms.lastClickedIndex = null;
    for (const t of $$(".tab")) t.classList.toggle("active", t === tab);
    render();
  });
}

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

function avatar(name, pic, fallback) {
  const el = document.createElement("div");
  el.className = "avatar";
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  if (pic) {
    const img = document.createElement("img");
    img.src = pic;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => { el.textContent = initial; };
    el.appendChild(img);
  } else {
    el.textContent = fallback || initial;
  }
  return el;
}

function badge(text) {
  const b = document.createElement("span");
  b.className = "badge";
  b.textContent = text;
  return b;
}

function rowShell(index, selected) {
  const li = document.createElement("li");
  li.className = "thread" + (selected ? " selected" : "");
  li.dataset.index = index;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected;
  cb.tabIndex = -1;
  li.appendChild(cb);
  return li;
}

function threadRow(t, index, selected) {
  const li = rowShell(index, selected);

  const main = document.createElement("div");
  main.className = "thread-main";
  const title = document.createElement("div");
  title.className = "thread-title";
  title.textContent = t.title;
  if (t.is_group) title.appendChild(badge("grupo"));
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

  const pic = t.users.length === 1 ? t.users[0].pic : null;
  li.append(avatar(t.title, pic, t.is_group ? "👥" : null), main, date);
  return li;
}

function renderDms() {
  // Enquanto carrega, mostra só o contador; a lista aparece inteira no final.
  $("#loading-panel").hidden = !state.loading;
  $("#thread-list").hidden = state.loading;
  $("#select-all").disabled = state.loading;
  const items = state.loading ? [] : filteredThreads();
  renderRows(views.dms, items, threadRow);
  $("#empty").hidden = items.length > 0 || state.loading;
  $("#visible-count").textContent = fmt(items.length);
}

// ------------------------------------------------ Seguidores / seguindo ---

function peopleReady() {
  return state.people.done.followers && state.people.done.following;
}

function peopleDiff() {
  const p = state.people;
  const followerIds = new Set(p.followers.map((u) => u.id));
  const followingIds = new Set(p.following.map((u) => u.id));
  return {
    nfb: p.following.filter((u) => !followerIds.has(u.id)),
    fnb: p.followers.filter((u) => !followingIds.has(u.id)),
  };
}

async function loadPeople() {
  const p = state.people;
  if (p.loading) return;
  p.loading = true;
  p.loadError = null;
  render();
  updatePeopleStatus();
  try {
    for (const which of ["followers", "following"]) {
      while (!p.done[which]) {
        const params = new URLSearchParams({ list: which });
        if (p.cursors[which]) params.set("cursor", p.cursors[which]);
        const data = await api(`/api/people?${params}`);
        if (data.total != null) p.totals[which] = data.total;
        const known = new Set(p[which].map((u) => u.id));
        for (const u of data.users) if (!known.has(u.id)) p[which].push(u);
        p.cursors[which] = data.cursor;
        if (!data.cursor || !data.users.length) p.done[which] = true;
        updatePeopleStatus();
      }
    }
  } catch (err) {
    p.loadError = err.message;
    if (err.status === 401) await waitForLogin();
  } finally {
    p.loading = false;
    render();
    updatePeopleStatus();
    if (peopleReady() && !p.snapshotted) takeSnapshot();
  }
}

function updatePeopleStatus() {
  const p = state.people;
  const ready = peopleReady();
  const diff = ready ? peopleDiff() : null;
  $("#count-nfb").textContent = diff ? fmt(diff.nfb.length) : "";
  $("#count-fnb").textContent = diff ? fmt(diff.fnb.length) : "";
  for (const which of ["followers", "following"]) {
    $(`#people-count-${which}`).textContent = fmt(p[which].length);
    $(`#people-total-${which}`).textContent = p.totals[which] != null ? ` de ${fmt(p.totals[which])}` : "";
  }
  const status = $("#people-status");
  const btn = $("#people-reload-btn");
  btn.disabled = p.loading;
  if (p.loading) status.textContent = "Carregando…";
  else if (ready) status.textContent = `${fmt(p.followers.length)} seguidores · seguindo ${fmt(p.following.length)}`;
  else status.textContent = "";
}

function resetPeopleAndLoad() {
  state.people = emptyPeople();
  views.nfb.selected.clear();
  views.fnb.selected.clear();
  loadPeople();
}

$("#people-reload-btn").addEventListener("click", resetPeopleAndLoad);
$("#people-continue-btn").addEventListener("click", () => loadPeople());

function filteredPeople() {
  const list = peopleDiff()[state.section];
  const q = normalize($("#people-search").value.trim());
  const hideVerified = $("#hide-verified").checked;
  return list.filter((u) => {
    if (hideVerified && u.is_verified) return false;
    if (q && !normalize(`${u.username} ${u.full_name}`).includes(q)) return false;
    return true;
  });
}

for (const el of ["#people-search", "#hide-verified"]) {
  $(el).addEventListener("input", () => { currentView().lastClickedIndex = null; render(); });
}

function personRow(u, index, selected) {
  const li = rowShell(index, selected);

  const main = document.createElement("div");
  main.className = "thread-main";
  const title = document.createElement("div");
  title.className = "thread-title";
  const link = document.createElement("a");
  link.href = `https://www.instagram.com/${encodeURIComponent(u.username)}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "profile-link";
  link.textContent = u.username;
  link.title = "Abrir perfil no Instagram";
  title.appendChild(link);
  if (u.is_verified) title.appendChild(badge("verificada"));
  if (u.is_private) title.appendChild(badge("privada"));
  const sub = document.createElement("div");
  sub.className = "thread-sub";
  sub.textContent = u.full_name || " ";
  main.append(title, sub);

  li.append(avatar(u.username, u.pic), main);
  return li;
}

const PEOPLE_HELP = {
  nfb: "Pessoas que você segue, mas que não te seguem de volta.",
  fnb: "Pessoas que te seguem, mas que você não segue de volta.",
};

function renderPeople() {
  const p = state.people;
  const ready = peopleReady();
  $("#people-help").textContent = PEOPLE_HELP[state.section];
  $("#people-loading").hidden = !p.loading;
  $("#people-error").hidden = p.loading || !p.loadError;
  $("#people-error-text").textContent = p.loadError || "";
  $("#people-select-all").disabled = !ready;
  $("#people-list").hidden = !ready;

  const items = ready ? filteredPeople() : [];
  renderRows(currentView(), items, personRow);
  $("#people-empty").hidden = !ready || items.length > 0;
  $("#people-visible-count").textContent = fmt(items.length);

  // O Instagram às vezes entrega menos seguidores do que o total do perfil.
  const warn = $("#people-warning");
  const total = p.totals.followers;
  const missing = ready && total ? total - p.followers.length : 0;
  if (state.section === "nfb" && missing > Math.max(5, total * 0.02)) {
    warn.textContent = `Atenção: o Instagram só entregou ${fmt(p.followers.length)} dos seus ${fmt(total)} seguidores. `
      + "Algumas pessoas podem aparecer aqui por engano. Confira antes de deixar de seguir, ou clique em Recarregar.";
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

// ------------------------------------------------------------ Seleção ---

function renderRows(view, items, rowFn) {
  view.visible = items;
  const frag = document.createDocumentFragment();
  items.forEach((it, i) => frag.appendChild(rowFn(it, i, view.selected.has(it.id))));
  $(view.list).replaceChildren(frag);
}

function setRowSelected(view, index, on) {
  const item = view.visible[index];
  if (!item) return;
  if (on) view.selected.add(item.id); else view.selected.delete(item.id);
  const li = $(`${view.list} > li[data-index="${index}"]`);
  if (li) {
    li.classList.toggle("selected", on);
    li.querySelector("input").checked = on;
  }
}

function renderActionBar() {
  const view = currentView();
  const n = view.selected.size;
  $("#selected-count").textContent = fmt(n);
  $("#actionbar").hidden = n === 0;

  const visSel = view.visible.filter((it) => view.selected.has(it.id)).length;
  const all = $(view.selectAll);
  all.checked = view.visible.length > 0 && visSel === view.visible.length;
  all.indeterminate = visSel > 0 && visSel < view.visible.length;

  const buttons = [];
  const clear = document.createElement("button");
  clear.className = "btn ghost";
  clear.textContent = "Limpar seleção";
  clear.addEventListener("click", () => { view.selected.clear(); render(); });
  buttons.push(clear);
  for (const kind of SECTION_ACTIONS[viewKey()]) {
    const b = document.createElement("button");
    b.className = `btn ${ACTIONS[kind].buttonClass}`;
    b.textContent = ACTIONS[kind].button;
    b.addEventListener("click", () => openConfirm(kind));
    buttons.push(b);
  }
  $("#action-buttons").replaceChildren(...buttons);
}

// Clique numa linha marca/desmarca. Shift+clique marca um intervalo.
function onListClick(e) {
  if (e.target.closest("a")) return; // link do perfil
  const li = e.target.closest("li.thread");
  if (!li) return;
  const view = currentView();
  if (view.static) return;
  const index = Number(li.dataset.index);
  const item = view.visible[index];
  const on = !view.selected.has(item.id);
  if (e.shiftKey && view.lastClickedIndex !== null) {
    const [a, b] = [view.lastClickedIndex, index].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) setRowSelected(view, i, on);
  } else {
    setRowSelected(view, index, on);
  }
  view.lastClickedIndex = index;
  renderActionBar();
}

$("#thread-list").addEventListener("click", onListClick);
$("#people-list").addEventListener("click", onListClick);
$("#analysis-list").addEventListener("click", onListClick);

for (const sel of ["#select-all", "#people-select-all", "#analysis-select-all"]) {
  $(sel).addEventListener("change", (e) => {
    const view = currentView();
    for (let i = 0; i < view.visible.length; i++) setRowSelected(view, i, e.target.checked);
    renderActionBar();
  });
}

// ------------------------------------------------------- Ações em lote ---

function threadById(id) {
  return state.threads.inbox.find((t) => t.id === id) || state.threads.pending.find((t) => t.id === id);
}

function personById(id) {
  return state.people.following.find((u) => u.id === id) || state.people.followers.find((u) => u.id === id)
    || analysisUnfollowers().find((u) => u.id === id);
}

function labelFor(kind, id) {
  if (kind === "delete_threads") return threadById(id)?.title || id;
  const u = personById(id);
  return u ? `@${u.username}` : id;
}

let pendingAction = null;

function loadPref(name, fallback) {
  try {
    const v = localStorage.getItem(`pref:${name}`);
    return v === null ? fallback : v === "1";
  } catch (_) { return fallback; }
}

function savePref(name, on) {
  try { localStorage.setItem(`pref:${name}`, on ? "1" : "0"); } catch (_) { /* sem storage */ }
}

const unsendChosen = () => pendingAction?.kind === "delete_threads" && $("#opt-unsend").checked;

function updateConfirmTime() {
  if (!pendingAction) return;
  const { kind, ids } = pendingAction;
  const action = ACTIONS[kind];
  const avg = state.delays[kind];
  if (unsendChosen()) {
    $("#confirm-text").textContent = "Para cada conversa, o app lê o histórico inteiro, cancela o envio de "
      + "cada mensagem sua e depois exclui a conversa da sua caixa de entrada. Isso não pode ser desfeito.";
    $("#confirm-time").textContent = "Demora bem mais: uma mensagem por vez, uns 2 a 3 segundos cada "
      + "(uma conversa com 300 mensagens suas leva uns 15 minutos). Pode deixar rodando.";
  } else {
    $("#confirm-text").textContent = action.text;
    $("#confirm-time").textContent = avg
      ? `Vai levar ${formatDuration(ids.length * avg)} (uma pausa entre cada uma para o Instagram não bloquear).`
      : "";
  }
}

$("#opt-unsend").addEventListener("change", (e) => {
  savePref("unsend", e.target.checked);
  updateConfirmTime();
});

function openConfirm(kind) {
  const action = ACTIONS[kind];
  const ids = [...currentView().selected];
  pendingAction = { kind, ids };

  $("#confirm-title").textContent = action.title(fmt(ids.length));
  $("#confirm-options").hidden = kind !== "delete_threads";
  if (kind === "delete_threads") $("#opt-unsend").checked = loadPref("unsend", true);
  updateConfirmTime();
  const warn = $("#confirm-warning");
  warn.hidden = !(action.risky && ids.length > 100);
  warn.textContent = "O Instagram costuma bloquear temporariamente quem segue ou deixa de seguir muita gente "
    + "no mesmo dia. O mais seguro é fazer em lotes de até 100 por dia.";

  const items = ids.slice(0, 50).map((id) => {
    const li = document.createElement("li");
    li.textContent = labelFor(kind, id);
    return li;
  });
  if (ids.length > 50) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = `…e mais ${fmt(ids.length - 50)}`;
    items.push(li);
  }
  $("#confirm-preview").replaceChildren(...items);
  const ok = $("#confirm-ok");
  ok.textContent = action.ok;
  ok.className = `btn ${action.okClass}`;
  $("#confirm-dialog").showModal();
}

$("#confirm-dialog").addEventListener("close", async () => {
  if ($("#confirm-dialog").returnValue !== "ok" || !pendingAction) return;
  const { kind, ids } = pendingAction;
  const unsend = unsendChosen();
  pendingAction = null;
  const action = ACTIONS[kind];
  try {
    await api(action.endpoint, { body: { action: kind, [action.bodyKey]: ids, unsend } });
    watchJob();
  } catch (err) {
    toast(err.message);
  }
});

// Aplica na tela o que já deu certo no servidor.
function applySucceeded(kind, ids) {
  const gone = new Set(ids);
  if (kind === "delete_threads") {
    for (const id of ids) state.removedByJob.add(id);
    for (const folder of ["inbox", "pending"]) {
      state.threads[folder] = state.threads[folder].filter((t) => !gone.has(t.id));
    }
    for (const id of ids) views.dms.selected.delete(id);
    updateLoadStatus();
  } else {
    const p = state.people;
    if (kind === "unfollow") {
      p.following = p.following.filter((u) => !gone.has(u.id));
    } else if (kind === "remove_follower") {
      p.followers = p.followers.filter((u) => !gone.has(u.id));
    } else if (kind === "follow") {
      const known = new Set(p.following.map((u) => u.id));
      for (const u of p.followers) if (gone.has(u.id) && !known.has(u.id)) p.following.push(u);
    }
    for (const id of ids) for (const k of ["nfb", "fnb", "unfollowers", "ghosts"]) views[k].selected.delete(id);
    updatePeopleStatus();
  }
  render();
}

let watching = false;

async function watchJob() {
  if (watching) return;
  watching = true;
  const dlg = $("#progress-dialog");
  $("#cancel-job").hidden = false;
  $("#cancel-job").disabled = false;
  $("#close-progress").hidden = true;
  $("#progress-errors").replaceChildren();
  $("#progress-hint").hidden = false;
  $("#progress-title").textContent = "Trabalhando…";
  if (!dlg.open) dlg.showModal();

  let applied = 0;
  try {
    for (;;) {
      const { job } = await api("/api/status");
      if (!job) break;
      const action = ACTIONS[job.kind] || ACTIONS.delete_threads;
      const avg = state.delays[job.kind] || 0;
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      $("#progress-fill").style.width = `${pct}%`;
      const unsend = Boolean(job.options && job.options.unsend);
      const left = (job.total - job.done) * avg;
      $("#progress-text").textContent = `${fmt(job.done)} de ${fmt(job.total)}`
        + (job.done < job.total && avg && !unsend ? ` · falta ${formatDuration(left)}` : "")
        + (job.unsent ? ` · ${fmt(job.unsent)} mensagem(ns) com envio cancelado` : "");
      const detail = $("#progress-detail");
      detail.hidden = !(job.status === "running" && job.current);
      if (!detail.hidden) {
        detail.textContent = `Agora: ${labelFor(job.kind, job.current)}` + (job.detail ? ` — ${job.detail}` : "");
      }
      $("#progress-hint").textContent = unsend
        ? "Cancelando uma mensagem por vez para o Instagram não bloquear sua conta. Conversas longas demoram. "
          + "Pode deixar rodando; a janela do app precisa continuar aberta."
        : avg
          ? `Tem uma pausa de uns ${Math.round(avg)} segundos entre cada uma para o Instagram não bloquear sua conta. `
            + "Pode deixar rodando; a janela do app precisa continuar aberta."
          : "";

      if (job.succeeded.length > applied) {
        applySucceeded(job.kind, job.succeeded.slice(applied));
        applied = job.succeeded.length;
      }

      if (job.status === "running") {
        $("#progress-title").textContent = action.progress;
      } else {
        $("#progress-title").textContent =
          job.status === "finished" ? "Pronto!" : job.status === "cancelled" ? "Parado" : "Interrompido";
        $("#progress-text").textContent = job.message || "";
        $("#progress-hint").hidden = true;
        const errs = job.failed.map((f) => {
          const li = document.createElement("li");
          li.textContent = `${labelFor(job.kind, f.id)}: ${f.error}`;
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
// Não deixa fechar com Esc enquanto está rodando.
$("#progress-dialog").addEventListener("cancel", (e) => { if (watching) e.preventDefault(); });

// ------------------------------------------------------------- Análise ---

const AN_HELP = {
  summary: "Resumo da sua conta. O histórico fica salvo só neste computador e cresce a cada vez que você abre esta aba.",
  unfollowers: "Quem te seguia e deixou de seguir, desde a primeira vez que você abriu a Análise.",
  ghosts: "Seguidores que não curtiram nem comentaram nenhuma das suas últimas publicações.",
  fans: "Quem mais curte e comenta suas últimas publicações.",
  stories: "Quem viu os stories que estão no ar agora (o Instagram só guarda isso enquanto o story está no ar).",
};

const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const dayTimeFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const shortDayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });

async function enterAnalysis() {
  const a = state.analytics;
  if (!a.data) {
    try { a.data = await api("/api/analytics"); } catch (err) { if (err.status === 401) await waitForLogin(); }
  }
  if (!peopleReady() && !state.people.loading) {
    if (state.people.loadError) { state.people.loadError = null; }
    loadPeople();
  } else if (peopleReady() && !state.people.snapshotted) {
    takeSnapshot();
  }
  render();
}

async function takeSnapshot() {
  const a = state.analytics;
  const p = state.people;
  if (a.snapshotting) return;
  a.snapshotting = true;
  a.error = null;
  render();
  try {
    const res = await api("/api/analytics/snapshot", {
      body: { followers: p.followers, following_count: p.following.length },
    });
    a.data = res.analytics;
    a.change = res.change;
    p.snapshotted = true;
  } catch (err) {
    a.error = err.message;
    if (err.status === 401) await waitForLogin();
  } finally {
    a.snapshotting = false;
    render();
  }
}

$("#an-retry-btn").addEventListener("click", () => {
  state.analytics.error = null;
  if (state.people.loadError) loadPeople(); else takeSnapshot();
});

for (const tab of $$(".an-tab")) {
  tab.addEventListener("click", () => {
    state.analytics.tab = tab.dataset.an;
    for (const t of $$(".an-tab")) t.classList.toggle("active", t === tab);
    $("#an-search").value = "";
    render();
  });
}
$("#an-search").addEventListener("input", () => { currentView().lastClickedIndex = null; render(); });

// Junta todos os "deixou de seguir" registrados, o mais recente primeiro.
function analysisUnfollowers() {
  const events = state.analytics.data?.events || [];
  const seen = new Map();
  for (let i = events.length - 1; i >= 0; i--) {
    for (const u of events[i].lost) if (!seen.has(u.id)) seen.set(u.id, { ...u, at: events[i].at });
  }
  // Quem voltou a seguir depois sai da lista.
  const followerIds = new Set(state.people.followers.map((u) => u.id));
  return [...seen.values()].filter((u) => !followerIds.has(u.id));
}

function engagementPeople() {
  const e = state.analytics.data?.engagement;
  return e ? e.people : [];
}

function analysisGhosts() {
  const e = state.analytics.data?.engagement;
  if (!e) return [];
  const active = new Set(e.people.map((u) => u.id));
  return state.people.followers.filter((u) => !active.has(u.id));
}

function analysisFans() {
  return [...engagementPeople()]
    .sort((x, y) => (y.likes + y.comments * 2) - (x.likes + x.comments * 2))
    .slice(0, 100);
}

function analysisRow(view, extra) {
  return (u, index, selected) => {
    const li = personRow(u, index, selected);
    if (view.static) {
      li.classList.add("static");
      li.querySelector("input").remove();
    }
    const info = extra(u);
    if (info.sub) li.querySelector(".thread-sub").textContent = info.sub;
    for (const b of info.badges || []) li.querySelector(".thread-title").appendChild(badge(b));
    return li;
  };
}

function filterBySearch(list) {
  const q = normalize($("#an-search").value.trim());
  return q ? list.filter((u) => normalize(`${u.username} ${u.full_name}`).includes(q)) : list;
}

function renderAnalysis() {
  const a = state.analytics;
  const p = state.people;
  const tab = a.tab;
  const view = views[tab];
  const busy = p.loading || a.snapshotting || (!peopleReady() && !p.loadError);
  const error = p.loadError || a.error;

  $("#an-help").textContent = AN_HELP[tab];
  $("#an-loading").hidden = !busy;
  if (busy) {
    $("#an-loading-title").textContent = a.snapshotting
      ? "Comparando com a última análise…"
      : "Carregando seus seguidores…";
    $("#an-loading-text").textContent = a.snapshotting
      ? "Conferindo com o Instagram quem deixou de te seguir. Pode levar até um minuto."
      : `Seguidores: ${fmt(p.followers.length)}${p.totals.followers != null ? ` de ${fmt(p.totals.followers)}` : ""}`
        + ` · Seguindo: ${fmt(p.following.length)}${p.totals.following != null ? ` de ${fmt(p.totals.following)}` : ""}`;
  }
  $("#an-error").hidden = busy || !error;
  $("#an-error-text").textContent = error || "";
  const ready = !busy && !error;

  const unfollowers = ready ? analysisUnfollowers() : [];
  const ghosts = ready ? analysisGhosts() : [];
  $("#count-an-unfollowers").textContent = ready && a.data?.has_baseline ? fmt(unfollowers.length) : "";
  $("#count-an-ghosts").textContent = ready && a.data?.engagement ? fmt(ghosts.length) : "";

  $("#an-summary").hidden = !ready || tab !== "summary";
  $("#an-engagement-bar").hidden = !ready || !["ghosts", "fans"].includes(tab);
  $("#an-stories-bar").hidden = !ready || tab !== "stories";
  if (ready && tab === "summary") renderSummary();
  if (ready && ["ghosts", "fans"].includes(tab)) renderEngagementBar();
  if (ready && tab === "stories") renderStoriesBar();

  let items = [];
  let row = personRow;
  let empty = "";
  if (ready && tab === "unfollowers") {
    items = unfollowers;
    const followingIds = new Set(p.following.map((u) => u.id));
    row = analysisRow(view, (u) => ({
      sub: `Deixou de seguir até ${dayFmt.format(new Date(u.at))}` + (u.gone ? " · conta apagada ou desativada" : ""),
      badges: followingIds.has(u.id) ? ["você ainda segue"] : [],
    }));
    empty = a.change?.first || !a.data?.has_baseline
      ? "Primeira análise salva agora. A partir da próxima vez que você abrir esta aba, aparece aqui quem deixou de te seguir."
      : "Ninguém deixou de te seguir desde que você começou a usar a Análise.";
  } else if (ready && tab === "ghosts") {
    const e = a.data?.engagement;
    items = ghosts;
    row = analysisRow(view, () => ({ sub: `Nenhuma curtida ou comentário nas últimas ${e?.posts.length} publicações` }));
    empty = e ? "Nenhum fantasma: todos os seus seguidores interagiram com alguma publicação."
      : "Clique em “Analisar publicações” para descobrir quem nunca interage com você.";
  } else if (ready && tab === "fans") {
    const followerIds = new Set(p.followers.map((u) => u.id));
    items = analysisFans();
    row = analysisRow(view, (u) => ({
      sub: `${fmt(u.likes)} curtida(s) · ${fmt(u.comments)} publicação(ões) comentada(s)`,
      badges: followerIds.has(u.id) ? [] : ["não te segue"],
    }));
    empty = a.data?.engagement ? "Ninguém curtiu ou comentou suas últimas publicações."
      : "Clique em “Analisar publicações” para ver quem mais interage com você.";
  } else if (ready && tab === "stories") {
    const st = a.data?.stories;
    items = st ? [...st.viewers].sort((x, y) => y.views - x.views || y.liked - x.liked) : [];
    row = analysisRow(view, (u) => ({
      sub: `Viu ${fmt(u.views)} de ${fmt(st.stories)} story(s)` + (u.liked ? ` · curtiu ${fmt(u.liked)}` : ""),
    }));
    empty = !st ? "Clique em “Ver quem viu” para carregar quem viu seus stories que estão no ar."
      : st.stories ? "Ninguém viu seus stories ainda." : "Você não tem nenhum story no ar agora.";
  }
  items = filterBySearch(items);

  const showList = ready && tab !== "summary";
  $("#an-listbar").hidden = !showList || (!items.length && !$("#an-search").value);
  $("#an-select-wrap").hidden = view.static;
  $("#analysis-list").hidden = !showList;
  renderRows(view, showList ? items : [], row);
  $("#an-visible-count").textContent = fmt(items.length);
  $("#an-empty").hidden = !showList || items.length > 0;
  $("#an-empty").textContent = $("#an-search").value ? "Ninguém encontrado." : empty;
}

// ----- Resumo e gráficos

function tile(label, value, sub) {
  const el = document.createElement("div");
  el.className = "tile";
  const l = document.createElement("div"); l.className = "tile-label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "tile-value"; v.textContent = value;
  const s = document.createElement("div"); s.className = "tile-sub"; s.textContent = sub || "";
  el.append(l, v, s);
  return el;
}

const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : "0");

function renderSummary() {
  const a = state.analytics;
  const d = a.data;
  const p = state.people;
  const history = d?.history || [];

  // O que mudou desde a última vez
  const news = $("#an-news");
  const c = a.change;
  if (c && c.first) {
    news.textContent = "Primeira análise salva. Da próxima vez que você abrir esta aba, o app mostra quem deixou "
      + "de te seguir e quem começou a seguir nesse meio tempo.";
    news.hidden = false;
  } else if (c) {
    const prev = history.length > 1 ? history[history.length - 2].at : null;
    const since = prev ? ` (${dayTimeFmt.format(new Date(prev))})` : "";
    news.textContent = c.lost.length || c.gained.length
      ? `Desde a última análise${since}: ${fmt(c.gained.length)} começaram a te seguir e `
        + `${fmt(c.lost.length)} deixaram de seguir.`
      : `Nada mudou nos seus seguidores desde a última análise${since}.`;
    news.hidden = false;
  } else {
    news.hidden = true;
  }

  const first = history[0];
  const totalLost = analysisUnfollowers().length;
  const e = d?.engagement;
  let engagement = "—";
  let engagementSub = "Analise suas publicações na aba Fantasmas ou Top fãs";
  if (e && e.posts.length && p.followers.length) {
    const avg = e.posts.reduce((sum, x) => sum + x.likes + x.comments, 0) / e.posts.length;
    engagement = `${(avg / p.followers.length * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
    engagementSub = `média de ${fmt(Math.round(avg))} interações por publicação`;
  }
  $("#an-tiles").replaceChildren(
    tile("Seguidores", fmt(p.followers.length),
      first && history.length > 1 ? `${signed(p.followers.length - first.followers)} desde ${dayFmt.format(new Date(first.at))}` : ""),
    tile("Seguindo", fmt(p.following.length), ""),
    tile("Deixaram de seguir", d?.has_baseline ? fmt(totalLost) : "—",
      first ? `desde ${dayFmt.format(new Date(first.at))}` : ""),
    tile("Engajamento", engagement, engagementSub),
  );

  // Gráfico 1: seguidores ao longo do tempo
  const followersEl = $("#chart-followers");
  if (history.length >= 2) {
    $("#chart-followers-sub").textContent = `${fmt(history.length)} análises desde ${dayFmt.format(new Date(first.at))}`;
    lineChart(followersEl, history.map((h) => ({
      x: new Date(h.at), y: h.followers, tip: `${dayTimeFmt.format(new Date(h.at))}\n${fmt(h.followers)} seguidores`,
    })), ["Data", "Seguidores"], (pt) => [dayTimeFmt.format(pt.x), fmt(pt.y)]);
  } else {
    $("#chart-followers-sub").textContent = "";
    chartEmpty(followersEl, "O gráfico aparece a partir da segunda análise. Abra esta aba de novo outro dia.");
  }

  // Gráfico 2: curtidas por publicação (da mais antiga para a mais nova)
  const postsEl = $("#chart-posts");
  if (e && e.posts.length) {
    const posts = [...e.posts].reverse();
    $("#chart-posts-sub").textContent = `Suas últimas ${posts.length} publicações, analisadas em ${dayTimeFmt.format(new Date(e.at))}`;
    columnChart(postsEl, posts.map((x) => ({
      label: x.taken_at ? shortDayFmt.format(new Date(x.taken_at)) : "",
      value: x.likes,
      tip: `${x.taken_at ? dayFmt.format(new Date(x.taken_at)) : "Publicação"}\n${fmt(x.likes)} curtidas · ${fmt(x.comments)} comentários`,
      row: [x.taken_at ? dayFmt.format(new Date(x.taken_at)) : "", fmt(x.likes), fmt(x.comments)],
    })), ["Publicação", "Curtidas", "Comentários"]);
  } else {
    $("#chart-posts-sub").textContent = "";
    chartEmpty(postsEl, "Clique em “Analisar publicações” na aba Fantasmas ou Top fãs para ver este gráfico.");
  }
}

function chartEmpty(el, text) {
  const p = document.createElement("div");
  p.className = "chart-empty";
  p.textContent = text;
  el.replaceChildren(p);
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

function niceNum(x) {
  const exp = Math.floor(Math.log10(x));
  const f = x / 10 ** exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * 10 ** exp;
}

function niceTicks(min, max, count = 4) {
  if (min === max) { min = Math.max(0, min - 1); max += 1; }
  const step = niceNum((max - min) / count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const tickLabel = (v, max) => (max >= 10000 ? compact.format(v) : fmt(v));

function chartFrame(el, ticks) {
  const W = Math.max(280, el.clientWidth || 600);
  const H = 200;
  const pad = { l: 44, r: 12, t: 10, b: 24 };
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo || 1));
  for (const t of ticks) {
    svg.appendChild(svgEl("line", { class: "grid-line", x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }));
    svg.appendChild(svgEl("text", { class: "axis-text", x: pad.l - 6, y: y(t) + 4, "text-anchor": "end" }, tickLabel(t, hi)));
  }
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  return { W, H, pad, svg, y, tip };
}

function showTip(el, f, tip, px, py, text) {
  tip.textContent = "";
  text.split("\n").forEach((line, i) => {
    const div = document.createElement("div");
    div.textContent = line;
    if (i === 0) div.style.opacity = ".75";
    tip.appendChild(div);
  });
  const scale = el.clientWidth / f.W;
  tip.style.left = `${px * scale}px`;
  tip.style.top = `${py * scale}px`;
  tip.hidden = false;
}

function tableView(headers, rows) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.className = "small muted";
  summary.textContent = "Ver em tabela";
  const table = document.createElement("table");
  table.className = "data-table";
  const tr = document.createElement("tr");
  for (const h of headers) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); }
  table.appendChild(tr);
  for (const r of rows) {
    const row = document.createElement("tr");
    for (const c of r) { const td = document.createElement("td"); td.textContent = c; row.appendChild(td); }
    table.appendChild(row);
  }
  details.append(summary, table);
  return details;
}

function lineChart(el, points, headers, rowFn) {
  const ys = points.map((p) => p.y);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const f = chartFrame(el, ticks);
  const t0 = points[0].x.getTime();
  const t1 = points[points.length - 1].x.getTime();
  const x = (d) => f.pad.l + (f.W - f.pad.l - f.pad.r) * ((d.getTime() - t0) / (t1 - t0 || 1));
  const base = f.y(ticks[0]);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${f.y(p.y).toFixed(1)}`).join("");
  f.svg.appendChild(svgEl("path", { class: "series-area", d: `${line}L${x(points[points.length - 1].x)},${base}L${x(points[0].x)},${base}Z` }));
  f.svg.appendChild(svgEl("path", { class: "series-line", d: line }));
  const last = points[points.length - 1];
  f.svg.appendChild(svgEl("circle", { class: "series-dot", cx: x(last.x), cy: f.y(last.y), r: 4 }));
  // Datas no eixo de baixo: primeira e última
  for (const [p, anchor] of [[points[0], "start"], [last, "end"]]) {
    f.svg.appendChild(svgEl("text", { class: "axis-text", x: x(p.x), y: f.H - 6, "text-anchor": anchor }, shortDayFmt.format(p.x)));
  }
  // Hover: linha vertical + ponto + balão no ponto mais próximo
  const cross = svgEl("line", { class: "crosshair", y1: f.pad.t, y2: base, visibility: "hidden" });
  const dot = svgEl("circle", { class: "series-dot", r: 5, visibility: "hidden" });
  const hit = svgEl("rect", { class: "hit", x: f.pad.l, y: 0, width: f.W - f.pad.l - f.pad.r, height: f.H });
  f.svg.append(cross, dot, hit);
  const move = (ev) => {
    const box = f.svg.getBoundingClientRect();
    const mx = (ev.clientX - box.left) * (f.W / box.width);
    let best = points[0];
    for (const p of points) if (Math.abs(x(p.x) - mx) < Math.abs(x(best.x) - mx)) best = p;
    const px = x(best.x);
    const py = f.y(best.y);
    for (const [k, v] of [["x1", px], ["x2", px]]) cross.setAttribute(k, v);
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
    showTip(el, f, f.tip, px, py, best.tip);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); f.tip.hidden = true;
  });
  f.svg.setAttribute("aria-label", `Seguidores: de ${fmt(points[0].y)} para ${fmt(last.y)}`);
  el.replaceChildren(f.svg, f.tip, tableView(headers, points.map(rowFn)));
}

function columnChart(el, bars, headers) {
  const ticks = niceTicks(0, Math.max(...bars.map((b) => b.value), 1));
  const f = chartFrame(el, ticks);
  const band = (f.W - f.pad.l - f.pad.r) / bars.length;
  const w = Math.min(24, band * 0.6);
  const base = f.y(0);
  bars.forEach((b, i) => {
    const cx = f.pad.l + band * (i + 0.5);
    const top = f.y(b.value);
    const h = base - top;
    const r = Math.min(4, h, w / 2);
    // Topo arredondado, base reta
    const d = h > 0
      ? `M${cx - w / 2},${base}V${top + r}Q${cx - w / 2},${top} ${cx - w / 2 + r},${top}H${cx + w / 2 - r}`
        + `Q${cx + w / 2},${top} ${cx + w / 2},${top + r}V${base}Z`
      : "";
    if (d) f.svg.appendChild(svgEl("path", { class: "series-bar", d }));
    // Só a data de algumas colunas quando não cabe todas (cada uma precisa de uns 60px).
    if (i % Math.max(1, Math.ceil(60 / band)) === 0) {
      f.svg.appendChild(svgEl("text", { class: "axis-text", x: cx, y: f.H - 6, "text-anchor": "middle" }, b.label));
    }
    const hit = svgEl("rect", { class: "hit", x: cx - band / 2, y: f.pad.t, width: band, height: base - f.pad.t });
    const show = () => showTip(el, f, f.tip, cx, top, b.tip);
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", () => { f.tip.hidden = true; });
    f.svg.appendChild(hit);
  });
  f.svg.setAttribute("aria-label", "Curtidas por publicação");
  el.replaceChildren(f.svg, f.tip, tableView(headers, bars.map((b) => b.row)));
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.section === "analysis" && state.analytics.tab === "summary") render();
  }, 150);
});

// ----- Análise das publicações (fantasmas e top fãs)

function renderEngagementBar() {
  const a = state.analytics;
  const e = a.data?.engagement;
  const btn = $("#an-engagement-btn");
  btn.disabled = a.engagementRunning;
  $("#an-posts").disabled = a.engagementRunning;
  const info = $("#an-engagement-info");
  if (a.engagementRunning) {
    const pr = a.engagementProgress;
    info.textContent = pr && pr.total ? `Analisando publicação ${fmt(Math.min(pr.done + 1, pr.total))} de ${fmt(pr.total)}…`
      : "Buscando suas publicações…";
  } else if (e) {
    const partial = e.posts.some((x) => x.likes > x.likers_listed * 1.1);
    info.textContent = `Baseado nas suas últimas ${e.posts.length} publicações, analisadas em ${dayTimeFmt.format(new Date(e.at))}.`
      + (partial ? " Em publicações com muitas curtidas o Instagram não mostra a lista inteira, então pode ter gente marcada como fantasma por engano." : "");
  } else {
    info.textContent = "Ainda não analisado.";
  }
}

$("#an-engagement-btn").addEventListener("click", async () => {
  const a = state.analytics;
  a.engagementRunning = true;
  a.engagementProgress = null;
  render();
  try {
    await api("/api/analytics/engagement", { body: { posts: Number($("#an-posts").value) } });
    for (;;) {
      await sleep(1000);
      const task = await api("/api/analytics/engagement");
      a.engagementProgress = task;
      if (task.status === "done") {
        a.data = { ...a.data, engagement: task.result };
        break;
      }
      if (task.status === "error") throw new Error(task.message || "Erro na análise.");
      if (state.section === "analysis") renderEngagementBar();
    }
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    a.engagementRunning = false;
    render();
  }
});

// ----- Quem viu os stories

function renderStoriesBar() {
  const a = state.analytics;
  const st = a.data?.stories;
  $("#an-stories-btn").disabled = a.storiesLoading;
  $("#an-stories-btn").textContent = st ? "Atualizar" : "Ver quem viu";
  $("#an-stories-info").textContent = a.storiesLoading ? "Carregando…"
    : st ? `${fmt(st.stories)} story(s) no ar · ${fmt(st.viewers.length)} pessoa(s) viram · atualizado em ${dayTimeFmt.format(new Date(st.at))}`
      : "";
}

$("#an-stories-btn").addEventListener("click", async () => {
  const a = state.analytics;
  a.storiesLoading = true;
  render();
  try {
    const st = await api("/api/analytics/stories");
    a.data = { ...a.data, stories: st };
  } catch (err) {
    toast(err.message, 6000);
    if (err.status === 401) await waitForLogin();
  } finally {
    a.storiesLoading = false;
    render();
  }
});

// ------------------------------------------------------------- Início ---

waitForLogin().catch((err) => {
  show("login");
  showError($("#login-error"), `Não foi possível falar com o servidor: ${err.message}`);
});
