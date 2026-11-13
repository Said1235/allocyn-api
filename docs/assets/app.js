(function () {
  var root = document.documentElement;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // theme
  var saved = store.get("allocyn.docs.theme");
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  var tbtn = document.getElementById("theme");
  function curTheme() { return root.getAttribute("data-theme") || "dark"; }
  function paintTheme() { if (tbtn) { tbtn.textContent = curTheme() === "dark" ? "Light" : "Dark"; tbtn.setAttribute("aria-label", "Switch to " + (curTheme() === "dark" ? "light" : "dark") + " theme"); } }
  if (tbtn) tbtn.addEventListener("click", function () { var n = curTheme() === "dark" ? "light" : "dark"; root.setAttribute("data-theme", n); store.set("allocyn.docs.theme", n); paintTheme(); });
  paintTheme();

  // mobile nav
  var side = document.getElementById("side"), mb = document.getElementById("menu");
  if (mb && side) mb.addEventListener("click", function () { var o = side.classList.toggle("open"); mb.setAttribute("aria-expanded", String(o)); });

  // diagrams: reveal when scrolled into view
  var figs = Array.prototype.slice.call(document.querySelectorAll(".diagram"));
  if (figs.length) {
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still || !("IntersectionObserver" in window)) figs.forEach(function (f) { f.classList.add("in"); });
    else { var dio = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); dio.unobserve(e.target); } }); }, { threshold: 0.2 }); figs.forEach(function (f) { dio.observe(f); }); }
  }

  // copy buttons
  document.querySelectorAll(".copy").forEach(function (b) {
    b.addEventListener("click", function () {
      var code = b.closest(".code").querySelector("code").innerText;
      var done = function () { b.setAttribute("data-done", ""); b.textContent = "Copied"; setTimeout(function () { b.removeAttribute("data-done"); b.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function () { b.textContent = "Press Ctrl+C"; });
      else { var r = document.createRange(); r.selectNodeContents(b.closest(".code").querySelector("code")); var s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = "Press Ctrl+C"; }
    });
  });

  // toc highlight
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll("aside.toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var map = {}; tocLinks.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { tocLinks.forEach(function (a) { a.classList.remove("on"); }); var a = map[e.target.id]; if (a) a.classList.add("on"); } }); }, { rootMargin: "-70px 0px -70% 0px" });
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }

  // search
  var input = document.getElementById("q"), box = document.getElementById("results"), index = null, sel = -1;
  function load() {
    if (index) return Promise.resolve(index);
    return fetch(document.documentElement.getAttribute("data-root") + "search-index.json").then(function (r) { return r.json(); }).then(function (j) { index = j; return j; }).catch(function () { index = []; return index; });
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function run(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) { box.classList.remove("open"); return; }
    var hits = [];
    index.forEach(function (d) {
      var score = 0, snip = "";
      terms.forEach(function (t) {
        if (d.title.toLowerCase().indexOf(t) >= 0) score += 8;
        d.sections.forEach(function (s) {
          if (s.h.toLowerCase().indexOf(t) >= 0) score += 4;
          var i = s.t.toLowerCase().indexOf(t);
          if (i >= 0) { score += 1; if (!snip) snip = s.t.slice(Math.max(0, i - 40), i + 90); }
        });
      });
      if (score) hits.push({ d: d, score: score, snip: snip });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    var root = document.documentElement.getAttribute("data-root");
    box.innerHTML = hits.length ? hits.slice(0, 8).map(function (h) { return '<a href="' + root + h.d.slug + '.html" role="option"><b>' + esc(h.d.title) + "</b><span>" + esc(h.snip || h.d.summary) + "</span></a>"; }).join("") : "<p>No results. Try fewer words.</p>";
    box.classList.add("open"); sel = -1;
  }
  if (input) {
    input.addEventListener("focus", load);
    input.addEventListener("input", function () { load().then(function () { run(input.value); }); });
    input.addEventListener("keydown", function (e) {
      var items = box.querySelectorAll("a");
      if (e.key === "ArrowDown" && items.length) { e.preventDefault(); sel = (sel + 1) % items.length; }
      else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; }
      else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); items[sel].click(); return; }
      else if (e.key === "Escape") { box.classList.remove("open"); input.blur(); return; }
      else return;
      items.forEach(function (a, i) { a.setAttribute("aria-selected", String(i === sel)); });
    });
    document.addEventListener("click", function (e) { if (!e.target.closest(".search")) box.classList.remove("open"); });
    document.addEventListener("keydown", function (e) { if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); } });
  }

  // try it
  var base = document.getElementById("base");
  if (base) base.value = /^https?:$/.test(location.protocol) ? location.origin : "http://localhost:8787";
  document.querySelectorAll(".try").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var path = f.getAttribute("data-path"), q = [];
      f.querySelectorAll("input[data-p]").forEach(function (i) { path = path.replace("{" + i.getAttribute("data-p") + "}", encodeURIComponent(i.value.trim())); });
      f.querySelectorAll("[data-q]").forEach(function (i) { if (i.value) q.push(i.getAttribute("data-q") + "=" + encodeURIComponent(i.value)); });
      var url = base.value.replace(/\/+$/, "") + path + (q.length ? "?" + q.join("&") : "");
      var out = f.parentNode.querySelector(".out code"), wrap = f.parentNode.querySelector(".out");
      wrap.hidden = false; out.textContent = "GET " + url + "\n…";
      fetch(url).then(function (r) { return r.text().then(function (t) { var body = t; try { body = JSON.stringify(JSON.parse(t), null, 2); } catch (x) {} out.textContent = "GET " + url + "\nHTTP " + r.status + "\n\n" + body; }); })
        .catch(function (err) { out.textContent = "GET " + url + "\nThe request failed: " + (err && err.message ? err.message : "network error") + ".\nIs the API running at that address, and does CORS_ORIGINS allow this page's origin?"; });
    });
  });
})();
