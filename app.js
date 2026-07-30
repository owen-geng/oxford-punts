import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.OXFORD_PUNTS_CONFIG || {};
const configured =
  typeof cfg.supabaseUrl === "string" && cfg.supabaseUrl.startsWith("https://") &&
  typeof cfg.supabaseAnonKey === "string" && !cfg.supabaseAnonKey.startsWith("PASTE");
const db = configured ? createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

const state = {
  players: [],
  transactions: [], // newest first, each with entries [{player_id, amount_pence, player: {name}}]
  balances: [],
  reversedBy: new Map(), // original tx id -> reversal tx
};

const $ = (sel) => document.querySelector(sel);

// ---------- money ----------
function fmtPence(p) {
  return `${p < 0 ? "−" : ""}£${(Math.abs(p) / 100).toFixed(2)}`;
}
function fmtSigned(p) {
  return `${p > 0 ? "+" : ""}${fmtPence(p)}`;
}
function parsePounds(value) {
  if (String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// ---------- data ----------
async function loadAll() {
  const [players, transactions, balances] = await Promise.all([
    db.from("players").select("id, name, created_at").order("name"),
    db.from("transactions")
      .select("id, kind, note, reverses, created_at, entries(id, player_id, amount_pence, player:players(name))")
      .order("created_at", { ascending: false }),
    db.from("balances").select("id, name, balance_pence, entry_count").order("name"),
  ]);
  const failed = [players, transactions, balances].find((r) => r.error);
  if (failed) throw failed.error;
  state.players = players.data;
  state.transactions = transactions.data;
  state.balances = balances.data;
  state.reversedBy = new Map();
  for (const tx of state.transactions) {
    if (tx.reverses) state.reversedBy.set(tx.reverses, tx);
  }
}

async function refresh() {
  try {
    await loadAll();
    renderAll();
  } catch (err) {
    showBanner(`Could not load the ledger: ${err.message}`, true);
  }
}

function showBanner(text, isError) {
  const el = $("#banner");
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle("error", Boolean(isError));
}

// ---------- tabs ----------
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab").forEach((s) =>
    s.classList.toggle("active", s.id === `tab-${btn.dataset.tab}`));
});

// ---------- balances ----------
function renderBalances() {
  const tbody = $("#balances-table tbody");
  const tfoot = $("#balances-table tfoot");
  tbody.innerHTML = "";
  for (const b of state.balances) {
    const tr = document.createElement("tr");
    const cls = b.balance_pence > 0 ? "pos" : b.balance_pence < 0 ? "neg" : "";
    tr.innerHTML = `<td>${esc(b.name)}</td><td class="num">${b.entry_count}</td>
      <td class="num ${cls}">${fmtPence(b.balance_pence)}</td>`;
    tbody.appendChild(tr);
  }
  const total = state.balances.reduce((s, b) => s + b.balance_pence, 0);
  tfoot.innerHTML = `<tr><td>Total</td><td></td><td class="num">${fmtPence(total)}</td></tr>`;
  if (state.balances.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3">No players yet — add some in the Players tab.</td></tr>`;
  }
}

// ---------- players ----------
function renderPlayers() {
  const tbody = $("#players-table tbody");
  tbody.innerHTML = "";
  const balanceOf = new Map(state.balances.map((b) => [b.id, b.balance_pence]));
  for (const p of state.players) {
    const bal = balanceOf.get(p.id) ?? 0;
    const cls = bal > 0 ? "pos" : bal < 0 ? "neg" : "";
    const joined = new Date(p.created_at).toLocaleDateString("en-GB", { dateStyle: "medium" });
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(p.name)}</td><td>${joined}</td><td class="num ${cls}">${fmtPence(bal)}</td>`;
    tbody.appendChild(tr);
  }
}

$("#add-player-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#player-name");
  const msg = $("#player-msg");
  msg.className = "msg";
  msg.textContent = "";
  const { data, error } = await db.rpc("add_player", { p_name: input.value });
  if (error) {
    msg.className = "msg error";
    msg.textContent = error.message;
    return;
  }
  msg.className = "msg ok";
  msg.textContent = `Added ${data.name}.`;
  input.value = "";
  await refresh();
});

// ---------- session form ----------
function playerOptions(selected) {
  return `<option value="">— player —</option>` + state.players
    .map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`)
    .join("");
}

function addSessionRow() {
  const row = document.createElement("div");
  row.className = "session-row";
  row.innerHTML = `
    <select class="row-player">${playerOptions("")}</select>
    <input class="row-amount" type="number" step="0.01" placeholder="±0.00">
    <button class="remove" type="button" title="Remove row">×</button>`;
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    validateSession();
  });
  row.addEventListener("input", validateSession);
  $("#session-rows").appendChild(row);
  validateSession();
}

function sessionEntries() {
  return [...document.querySelectorAll(".session-row")].map((row) => ({
    player_id: row.querySelector(".row-player").value,
    amount_pence: parsePounds(row.querySelector(".row-amount").value),
  }));
}

function validateSession() {
  const entries = sessionEntries();
  const sum = entries.reduce((s, e) => s + (e.amount_pence ?? 0), 0);
  const ids = entries.map((e) => e.player_id).filter(Boolean);
  const complete = entries.length >= 2 &&
    entries.every((e) => e.player_id && e.amount_pence !== null && e.amount_pence !== 0) &&
    new Set(ids).size === ids.length;
  const badge = $("#session-sum");
  badge.textContent = `Total: ${fmtPence(sum)}`;
  badge.classList.toggle("balanced", complete && sum === 0);
  $("#save-session").disabled = !(complete && sum === 0);
}

$("#add-row").addEventListener("click", addSessionRow);

$("#save-session").addEventListener("click", async () => {
  const msg = $("#session-msg");
  msg.className = "msg";
  msg.textContent = "Saving…";
  const { error } = await db.rpc("record_transaction", {
    p_kind: "session",
    p_note: $("#session-note").value,
    p_entries: sessionEntries(),
  });
  if (error) {
    msg.className = "msg error";
    msg.textContent = error.message;
    return;
  }
  msg.className = "msg ok";
  msg.textContent = "Session recorded.";
  $("#session-rows").innerHTML = "";
  $("#session-note").value = "";
  addSessionRow();
  addSessionRow();
  await refresh();
});

// ---------- settle form ----------
function renderSettleSelects() {
  for (const sel of [$("#settle-payer"), $("#settle-payee")]) {
    const current = sel.value;
    sel.innerHTML = playerOptions(current);
  }
}

function validateSettle() {
  const payer = $("#settle-payer").value;
  const payee = $("#settle-payee").value;
  const pence = parsePounds($("#settle-amount").value);
  const valid = payer && payee && payer !== payee && pence !== null && pence > 0;
  $("#save-settle").disabled = !valid;
  const preview = $("#settle-preview");
  if (valid) {
    const name = (id) => state.players.find((p) => p.id === id)?.name ?? "?";
    preview.textContent =
      `${name(payer)} pays ${name(payee)} ${fmtPence(pence)} → ledger: ` +
      `${name(payer)} ${fmtSigned(pence)}, ${name(payee)} ${fmtSigned(-pence)}`;
  } else {
    preview.textContent = "";
  }
}

for (const id of ["#settle-payer", "#settle-payee", "#settle-amount"]) {
  $(id).addEventListener("input", validateSettle);
}

$("#save-settle").addEventListener("click", async () => {
  const msg = $("#settle-msg");
  msg.className = "msg";
  msg.textContent = "Saving…";
  const pence = parsePounds($("#settle-amount").value);
  const { error } = await db.rpc("record_transaction", {
    p_kind: "settlement",
    p_note: $("#settle-note").value,
    p_entries: [
      { player_id: $("#settle-payer").value, amount_pence: pence },
      { player_id: $("#settle-payee").value, amount_pence: -pence },
    ],
  });
  if (error) {
    msg.className = "msg error";
    msg.textContent = error.message;
    return;
  }
  msg.className = "msg ok";
  msg.textContent = "Settlement recorded.";
  $("#settle-amount").value = "";
  $("#settle-note").value = "";
  validateSettle();
  await refresh();
});

// ---------- ledger ----------
function shortId(id) {
  return id.slice(0, 8);
}

function renderLedger() {
  const list = $("#ledger-list");
  list.innerHTML = "";
  if (state.transactions.length === 0) {
    list.innerHTML = `<p class="hint">Nothing in the ledger yet.</p>`;
    return;
  }
  for (const tx of state.transactions) {
    const card = document.createElement("div");
    card.className = "tx";
    const when = new Date(tx.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    const flags = [];
    if (tx.reverses) flags.push(`<span class="tx-flag">↩ reverses ${shortId(tx.reverses)}</span>`);
    if (state.reversedBy.has(tx.id)) {
      flags.push(`<span class="tx-flag">reversed by ${shortId(state.reversedBy.get(tx.id).id)}</span>`);
    }
    const entries = [...tx.entries].sort((a, b) => b.amount_pence - a.amount_pence)
      .map((e) => `<li><span>${esc(e.player?.name ?? "?")}</span>
        <span class="${e.amount_pence > 0 ? "pos" : "neg"}">${fmtSigned(e.amount_pence)}</span></li>`)
      .join("");
    card.innerHTML = `
      <div class="tx-head">
        <span class="tx-kind ${tx.kind}">${tx.kind}</span>
        <span class="tx-date">${when} · ${shortId(tx.id)}</span>
        ${tx.note ? `<span class="tx-note">${esc(tx.note)}</span>` : ""}
        ${flags.join(" ")}
      </div>
      <ul class="tx-entries">${entries}</ul>`;
    if (!state.reversedBy.has(tx.id)) {
      const btn = document.createElement("button");
      btn.className = "ghost reverse-btn";
      btn.textContent = "Reverse";
      btn.addEventListener("click", () => reverseTx(tx));
      card.appendChild(btn);
    }
    list.appendChild(card);
  }
}

async function reverseTx(tx) {
  const ok = confirm(
    `Post a reversal of this ${tx.kind}? The original stays in the ledger; ` +
    `a new transaction with the opposite entries is appended.`);
  if (!ok) return;
  const { error } = await db.rpc("reverse_transaction", { p_transaction_id: tx.id });
  if (error) {
    showBanner(`Reversal failed: ${error.message}`, true);
    return;
  }
  await refresh();
}

// ---------- properties ----------
function checkProperties() {
  const txs = state.transactions;
  const allEntries = txs.flatMap((t) => t.entries);
  const total = allEntries.reduce((s, e) => s + e.amount_pence, 0);

  const unbalanced = txs.filter((t) =>
    t.entries.reduce((s, e) => s + e.amount_pence, 0) !== 0 || t.entries.length < 2);

  const settlements = txs.filter((t) => t.kind === "settlement");
  const badSettlements = settlements.filter((t) =>
    t.entries.length !== 2 || t.entries[0].amount_pence !== -t.entries[1].amount_pence);

  const derived = new Map();
  for (const e of allEntries) {
    derived.set(e.player_id, (derived.get(e.player_id) ?? 0) + e.amount_pence);
  }
  const mismatched = state.balances.filter((b) => (derived.get(b.id) ?? 0) !== b.balance_pence);

  const reversals = txs.filter((t) => t.reverses);
  const badReversals = reversals.filter((rev) => {
    const orig = txs.find((t) => t.id === rev.reverses);
    if (!orig || orig.entries.length !== rev.entries.length) return true;
    const origByPlayer = new Map(orig.entries.map((e) => [e.player_id, e.amount_pence]));
    return !rev.entries.every((e) => origByPlayer.get(e.player_id) === -e.amount_pence);
  });

  return [
    {
      name: "Conservation of money",
      ok: total === 0,
      detail: `All ${allEntries.length} entries across ${txs.length} transactions sum to ${fmtPence(total)}. ` +
        `Poker is zero-sum, and so is this ledger.`,
    },
    {
      name: "Every transaction balances",
      ok: unbalanced.length === 0,
      detail: unbalanced.length === 0
        ? `Each of the ${txs.length} transactions has ≥ 2 entries summing to £0.00 on its own.`
        : `${unbalanced.length} transaction(s) do not balance!`,
    },
    {
      name: "Settlements are pure transfers",
      ok: badSettlements.length === 0,
      detail: `All ${settlements.length} settlement(s) are classic double entries: ` +
        `exactly two lines, equal and opposite.`,
    },
    {
      name: "Balances derive from the ledger",
      ok: mismatched.length === 0,
      detail: `The Balances tab is not stored anywhere — recomputing every player's balance ` +
        `from raw entries matches the database's balances view (${state.balances.length} players).`,
    },
    {
      name: "Reversals exactly negate their originals",
      ok: badReversals.length === 0,
      detail: `${reversals.length} reversal(s), each linked to its original and mirroring its ` +
        `entries with signs flipped. A transaction can be reversed at most once.`,
    },
    {
      name: "History is append-only",
      ok: true,
      detail: `UPDATE and DELETE on the ledger raise exceptions inside the database itself — ` +
        `no client, however hostile, can rewrite history. Prove it with the buttons below.`,
    },
  ];
}

function renderProps() {
  const list = $("#props-list");
  list.innerHTML = "";
  for (const p of checkProperties()) {
    const div = document.createElement("div");
    div.className = `prop ${p.ok ? "ok" : "fail"}`;
    div.innerHTML = `<div class="prop-icon">${p.ok ? "✓" : "✗"}</div>
      <div><div class="prop-name">${p.name}</div><div class="prop-detail">${p.detail}</div></div>`;
    list.appendChild(div);
  }
}

// ---------- try to break it ----------
function breakLog(lines) {
  const out = $("#break-output");
  out.hidden = false;
  out.textContent = lines.join("\n");
}

$("#break-direct").addEventListener("click", async () => {
  const attempt = "supabase.from('entries').insert({ transaction_id, player_id, amount_pence: 100 })";
  const { error } = await db.from("entries").insert({
    transaction_id: crypto.randomUUID(),
    player_id: crypto.randomUUID(),
    amount_pence: 100,
  });
  breakLog([
    `→ ${attempt}`,
    error ? `✗ REFUSED by the database: ${error.message} (${error.code})`
          : `!! accepted — this should never happen`,
    "",
    "Direct table writes are revoked; the only way in is the validated record_transaction RPC.",
  ]);
});

$("#break-unbalanced").addEventListener("click", async () => {
  if (state.players.length < 2) {
    breakLog(["Need at least 2 players to run this demonstration."]);
    return;
  }
  const [a, b] = state.players;
  const attempt = `record_transaction('session', …, [${esc(a.name)} +£1.00, ${esc(b.name)} +£1.00])`;
  const { error } = await db.rpc("record_transaction", {
    p_kind: "session",
    p_note: "attempted unbalanced write",
    p_entries: [
      { player_id: a.id, amount_pence: 100 },
      { player_id: b.id, amount_pence: 100 },
    ],
  });
  breakLog([
    `→ ${attempt}`,
    error ? `✗ REFUSED by the database: ${error.message}`
          : `!! accepted — this should never happen`,
    "",
    "Money cannot be created or destroyed: entries must sum to exactly zero.",
  ]);
});

$("#break-mutate").addEventListener("click", async () => {
  if (state.transactions.length === 0) {
    breakLog(["The ledger is empty — record a transaction first, then try to tamper with it."]);
    return;
  }
  const target = state.transactions[state.transactions.length - 1];
  const upd = await db.from("transactions").update({ note: "I never lost a penny" }).eq("id", target.id);
  const del = await db.from("transactions").delete().eq("id", target.id);
  breakLog([
    `→ supabase.from('transactions').update({ note: 'I never lost a penny' }).eq('id', '${shortId(target.id)}…')`,
    upd.error ? `✗ REFUSED by the database: ${upd.error.message} (${upd.error.code})`
              : `!! accepted — this should never happen`,
    "",
    `→ supabase.from('transactions').delete().eq('id', '${shortId(target.id)}…')`,
    del.error ? `✗ REFUSED by the database: ${del.error.message} (${del.error.code})`
              : `!! accepted — this should never happen`,
    "",
    "History is append-only. Even privileged server-side code is blocked by BEFORE",
    "UPDATE/DELETE triggers — corrections happen by posting a reversal, in the open.",
  ]);
});

// ---------- misc ----------
function esc(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

function renderAll() {
  renderBalances();
  renderPlayers();
  renderSettleSelects();
  validateSettle();
  document.querySelectorAll(".session-row .row-player").forEach((sel) => {
    sel.innerHTML = playerOptions(sel.value);
  });
  validateSession();
  renderLedger();
  renderProps();
}

async function init() {
  if (!configured) {
    showBanner("Backend not configured: fill in config.js with the Supabase project URL and anon key.", true);
    return;
  }
  addSessionRow();
  addSessionRow();
  await refresh();
}

init();
