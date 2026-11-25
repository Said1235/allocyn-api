(function () {
  "use strict";
  var BASE = /^https?:$/.test(location.protocol) ? location.origin : "";
  var STATUS = [
    ["OPEN", "Open", "var(--s-open)"], ["IN_PROGRESS", "In progress", "var(--s-prog)"], ["VERIFIED", "Verified", "var(--s-ok)"],
    ["NEEDS_REVISION", "Needs revision", "var(--s-rev)"], ["INCONCLUSIVE", "Inconclusive", "var(--s-inc)"]
  ];
  var VERDICT = [["VERIFIED", "Verified"], ["NEEDS_REVISION", "Needs revision"], ["INCONCLUSIVE", "Inconclusive"], ["PENDING", "Waiting for validators"]];
  var EVENT_TEXT = { job_created: "Job created", job_accepted: "Job accepted", delivery_submitted: "Delivery submitted", delivery_evaluated: "Delivery judged", status_changed: "Status changed" };
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat("en");

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function short(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; }
  function ago(iso, now) {
    var s = Math.max(0, Math.round(((now || Date.now()) - Date.parse(iso)) / 1000));
    if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago";
  }
  function get(path) {
    return fetch(BASE + path, { headers: { Accept: "application/json" } }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (b) {
        if (r.ok && b && b.success) return b.data;
        var err = new Error(b && b.error ? b.error.message : "HTTP " + r.status); err.code = b && b.error ? b.error.code : "HTTP_" + r.status; throw err;
      });
    });
  }

  // one shared tooltip, filled with textContent only
  var tip = el("div", "tip"); tip.setAttribute("role", "status"); tip.hidden = true; document.body.appendChild(tip);
  function showTip(target, lines) {
    clear(tip); tip.appendChild(el("b", "", lines[0])); if (lines[1]) tip.appendChild(el("span", "", lines[1])); tip.hidden = false;
    var r = target.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + "px";
  }
  function hideTip() { tip.hidden = true; }
  function hover(node, lines) {
    node.tabIndex = 0;
    node.addEventListener("pointerenter", function () { showTip(node, lines); });
    node.addEventListener("pointerleave", hideTip); node.addEventListener("focus", function () { showTip(node, lines); }); node.addEventListener("blur", hideTip);
  }

  function setFresh(state, text) { var c = $("fresh"); c.setAttribute("data-state", state); $("fresh-text").textContent = text; }

  function renderHealth(h) {
    var copy = h && h.copy, check = h && h.checks && h.checks.copy;
    if (!copy || check === "unavailable") { setFresh("bad", "Database copy unavailable"); return null; }
    if (check === "stale") setFresh("warn", "Stale · last sync " + (copy.syncedAt ? ago(copy.syncedAt) : "never"));
    else if (check === "failing") setFresh("warn", "Last indexer run failed · synced " + ago(copy.syncedAt));
    else setFresh("ok", "Synced " + ago(copy.syncedAt));
    return copy;
  }

  function renderStatus(stats) {
    var by = stats.jobs.byStatus, total = stats.jobs.total;
    $("hero-n").textContent = nf.format(total);
    var bar = clear($("bar")), legend = clear($("legend")), tbody = clear($("t-status"));
    bar.setAttribute("aria-label", total ? "Jobs by status: " + STATUS.map(function (s) { return (by[s[0]] || 0) + " " + s[1].toLowerCase(); }).join(", ") : "No jobs yet");
    STATUS.forEach(function (s) {
      var n = by[s[0]] || 0, pct = total ? Math.round((n / total) * 100) : 0;
      if (n) { var seg = el("div", "seg"); seg.style.flexGrow = String(n); seg.style.background = s[2]; if (n / total > 0.12) seg.textContent = pct + "%"; hover(seg, [nf.format(n) + " " + s[1].toLowerCase(), pct + "% of all jobs"]); bar.appendChild(seg); }
      var li = el("li"); var sw = el("i", "sw"); sw.style.background = s[2]; li.appendChild(sw); li.appendChild(el("span", "", s[1])); li.appendChild(el("b", "", nf.format(n))); legend.appendChild(li);
      var tr = el("tr"); tr.appendChild(el("td", "", s[1])); tr.appendChild(el("td", "num", nf.format(n))); tr.appendChild(el("td", "num", pct + "%")); tbody.appendChild(tr);
    });
    $("empty-status").hidden = total > 0; bar.hidden = total === 0;
  }

  function renderVerdicts(stats) {
    var host = clear($("verdicts")), r = stats.receipts;
    if (!r) { host.appendChild(el("p", "muted", "Deliveries are not in the copy yet.")); return; }
    $("n-del").textContent = nf.format(r.total);
    VERDICT.forEach(function (v) {
      var n = r.byOutcome[v[0]] || 0, row = el("div", "mrow"); row.appendChild(el("span", "mname", v[1]));
      var track = el("span", "track"), fill = el("span", "fill"); fill.style.width = (r.total ? (n / r.total) * 100 : 0) + "%"; track.appendChild(fill);
      row.appendChild(track); row.appendChild(el("b", "mval", nf.format(n))); hover(row, [nf.format(n) + " of " + nf.format(r.total) + " deliveries", v[1]]); host.appendChild(row);
    });
  }

  function dayKey(t) { return new Date(t).toISOString().slice(0, 10); }
  function renderDays(events) {
    var host = clear($("days")), tbody = clear($("t-days")), DAYS = 14, today = Date.now(), counts = {}, keys = [];
    for (var i = DAYS - 1; i >= 0; i--) { var k = dayKey(today - i * 86400000); keys.push(k); counts[k] = 0; }
    events.forEach(function (e) { if (e.type === "job_created") { var k = dayKey(e.detectedAt); if (k in counts) counts[k]++; } });
    var max = Math.max.apply(null, keys.map(function (k) { return counts[k]; }).concat([1])), sum = 0;
    keys.forEach(function (k, i) {
      var n = counts[k]; sum += n; var col = el("div", "col"), bar = el("span", "cb"); bar.style.height = Math.max(n ? 4 : 0, (n / max) * 100) + "%"; col.appendChild(bar);
      col.appendChild(el("small", "", (DAYS - 1 - i) % 4 === 0 ? k.slice(5) : ""));
      hover(col, [nf.format(n) + (n === 1 ? " job seen" : " jobs seen"), k]); host.appendChild(col);
      var tr = el("tr"); tr.appendChild(el("td", "", k)); tr.appendChild(el("td", "num", nf.format(n))); tbody.appendChild(tr);
    });
    $("days-empty").hidden = sum > 0;
  }

  function renderFeed(events) {
    var ul = clear($("feed")); $("feed-empty").hidden = events.length > 0;
    events.slice().reverse().slice(0, 20).forEach(function (e) {
      var li = el("li"), a = el("a", "", e.jobId); a.href = BASE + "/verify/" + encodeURIComponent(e.jobId);
      li.appendChild(el("span", "what", EVENT_TEXT[e.type] || e.type)); li.appendChild(a);
      if (e.toStatus) li.appendChild(el("span", "to", (e.fromStatus ? e.fromStatus + " → " : "") + e.toStatus));
      var t = el("time", "when", ago(e.detectedAt)); t.dateTime = e.detectedAt; t.title = e.detectedAt; li.appendChild(t); ul.appendChild(li);
    });
  }

  function errorText(e) {
    if (e.code === "COPY_UNAVAILABLE") return "This server has no database copy, so the panel has nothing to show.";
    if (e.code === "UPSTREAM_UNAVAILABLE") return "The database copy did not answer. It will be tried again on the next refresh.";
    return "Could not load the data: " + e.message;
  }

  var busy = false;
  function load() {
    if (busy) return; busy = true; $("panel").setAttribute("aria-busy", "true");
    Promise.all([get("/v1/health?deep=true").catch(function () { return null; }), get("/v1/stats"), get("/v1/events?limit=100")]).then(function (r) {
      $("err").hidden = true; $("panel").hidden = false;
      var copy = renderHealth(r[0]); renderStatus(r[1]); renderVerdicts(r[1]); renderDays(r[2].items); renderFeed(r[2].items);
      $("through").textContent = (copy && copy.copiedThrough) || r[1].copiedThrough || "none yet";
    }).catch(function (e) { $("err-text").textContent = errorText(e); $("err").hidden = false; setFresh("bad", "No data"); })
      .then(function () { busy = false; $("panel").removeAttribute("aria-busy"); });
  }
  var mb = $("lp-menu"), nv = $("lp-nav");
  if (mb && nv) mb.addEventListener("click", function () { mb.setAttribute("aria-expanded", String(nv.classList.toggle("open"))); });
  load();
  setInterval(function () { if (!document.hidden) load(); }, 30000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  $("retry").addEventListener("click", load);

  // address lookup
  $("addr-form").addEventListener("submit", function (ev) {
    ev.preventDefault(); var v = $("addr").value.trim(), out = clear($("addr-out"));
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { out.appendChild(el("p", "bad", "An address is 0x followed by 40 hexadecimal characters.")); return; }
    out.appendChild(el("p", "muted", "Looking up…"));
    get("/v1/addresses/" + v).then(function (d) {
      clear(out); var dl = el("dl", "kv");
      [["Jobs as worker", d.asWorker.jobs], ["Deliveries as worker", d.asWorker.deliveries], ["Jobs as client", d.asClient.jobs]].forEach(function (p) { var w = el("div"); w.appendChild(el("dt", "", p[0])); w.appendChild(el("dd", "", nf.format(p[1]))); dl.appendChild(w); });
      out.appendChild(dl); out.appendChild(el("p", "muted", "Counts only, from the copy synced " + (d.syncedAt ? ago(d.syncedAt) : "never") + ". No score and no ranking."));
    }).catch(function (e) { clear(out); out.appendChild(el("p", "bad", errorText(e))); });
  });
  document.querySelectorAll("[data-view]").forEach(function (b) {
    b.addEventListener("click", function () { var t = b.getAttribute("data-view"), box = $(t); box.hidden = !box.hidden; b.setAttribute("aria-expanded", String(!box.hidden)); b.textContent = box.hidden ? "Show as table" : "Hide table"; });
  });
})();
