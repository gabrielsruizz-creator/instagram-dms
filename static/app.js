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
};

function emptyPeople() {
  return {
    followers: [],
    following: [],
    cursors: { followers: null, following: null },
    done: { followers: false, following: false },
    totals: { followers: null, following: null },
    loading: false,
    loadError: null,
  };
}

// Cada lista tem sua própria seleção.
const views = {
  dms: { list: "#thread-list", selectAll: "#select-all", selected: new Set(), visible: [], lastClickedIndex: null },
  nfb: { list: "#people-list", selectAll: "#people-select-all", selected: new Set(), visible: [], lastClickedIndex: null },
  fnb: { list: "#people-list", selectAll: "#people-select-all", selected: new Set(), visible: [], lastClickedIndex: null },
};
const currentView = () => views[state.section];

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
    $("#section-people").hidden = state.section === "dms";
    if (state.section !== "dms" && !peopleReady() && !state.people.loading && !state.people.loadError) loadPeople();
    render();
  });
}

function render() {
  if (state.section === "dms") renderDms(); else renderPeople();
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
  for (const kind of SECTION_ACTIONS[state.section]) {
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

for (const sel of ["#select-all", "#people-select-all"]) {
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
  return state.people.following.find((u) => u.id === id) || state.people.followers.find((u) => u.id === id);
}

function labelFor(kind, id) {
  if (kind === "delete_threads") return threadById(id)?.title || id;
  const u = personById(id);
  return u ? `@${u.username}` : id;
}

let pendingAction = null;

function openConfirm(kind) {
  const action = ACTIONS[kind];
  const ids = [...currentView().selected];
  pendingAction = { kind, ids };

  $("#confirm-title").textContent = action.title(fmt(ids.length));
  $("#confirm-text").textContent = action.text;
  const avg = state.delays[kind];
  $("#confirm-time").textContent = avg
    ? `Vai levar ${formatDuration(ids.length * avg)} (uma pausa entre cada uma para o Instagram não bloquear).`
    : "";
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
  pendingAction = null;
  const action = ACTIONS[kind];
  try {
    await api(action.endpoint, { body: { action: kind, [action.bodyKey]: ids } });
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
    for (const id of ids) { views.nfb.selected.delete(id); views.fnb.selected.delete(id); }
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
      const left = (job.total - job.done) * avg;
      $("#progress-text").textContent = `${fmt(job.done)} de ${fmt(job.total)}`
        + (job.done < job.total && avg ? ` · falta ${formatDuration(left)}` : "");
      $("#progress-hint").textContent = avg
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

// ------------------------------------------------------------- Início ---

waitForLogin().catch((err) => {
  show("login");
  showError($("#login-error"), `Não foi possível falar com o servidor: ${err.message}`);
});
