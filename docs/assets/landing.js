(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function $(id) { return document.getElementById(id); }
  function read(id) { try { return JSON.parse($(id).textContent); } catch (e) { return null; } }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function color(line) {
    return esc(line).replace(/("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null|-?\d+(?:\.\d+)?)\b/g, function (m, str, colon, lit) {
      if (str) return colon ? '<span class="k">' + str + "</span>" + colon : '<span class="s">' + str + "</span>";
      return '<span class="n">' + lit + "</span>";
    });
  }
  function onVisible(el, fn) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { io.disconnect(); fn(); } }, { threshold: 0.25 });
    io.observe(el);
  }

  /* ------------------------------ terminal ------------------------------ */
  (function () {
    var scenes = read("term-data"), screen = $("term-screen"), badge = $("term-status"), pause = $("term-pause");
    if (!scenes || !screen) return;
    var i = 0, paused = false, timer = null, token = 0;
    function show(sc, full) {
      badge.textContent = sc.status;
      badge.className = sc.status >= 400 ? "bad" : "";
      var html = '<span class="p">$ </span>' + esc(sc.cmd);
      if (full) html += "\n" + sc.out.split("\n").map(color).join("\n");
      screen.innerHTML = html;
    }
    function wait(ms, my) { return new Promise(function (r) { timer = setTimeout(function () { r(my === token); }, ms); }); }
    async function holdWhilePaused(my) { while (paused && my === token) await wait(200, my); return my === token; }
    async function play() {
      var my = ++token;
      while (my === token) {
        var sc = scenes[i % scenes.length];
        badge.textContent = "…"; badge.className = "";
        var cmd = sc.cmd, typed = "";
        screen.innerHTML = '<span class="p">$ </span><i class="cur"></i>';
        if (!(await wait(450, my))) return;
        for (var c = 0; c < cmd.length; c++) {
          typed += cmd[c];
          screen.innerHTML = '<span class="p">$ </span>' + esc(typed) + '<i class="cur"></i>';
          if (!(await wait(26 + Math.random() * 30, my))) return;
          if (!(await holdWhilePaused(my))) return;
        }
        if (!(await wait(380, my))) return;
        badge.textContent = sc.status; badge.className = sc.status >= 400 ? "bad" : "";
        var lines = sc.out.split("\n"), shown = [];
        for (var l = 0; l < lines.length; l++) {
          shown.push(color(lines[l]));
          screen.innerHTML = '<span class="p">$ </span>' + esc(cmd) + "\n" + shown.join("\n") + '<i class="cur"></i>';
          if (!(await wait(55, my))) return;
          if (!(await holdWhilePaused(my))) return;
        }
        screen.innerHTML = '<span class="p">$ </span>' + esc(cmd) + "\n" + shown.join("\n");
        for (var h = 0; h < 36; h++) { if (!(await wait(100, my))) return; if (!(await holdWhilePaused(my))) return; }
        i++;
      }
    }
    if (reduce) {
      show(scenes[0], true);
      pause.hidden = false; pause.textContent = "Next example";
      pause.addEventListener("click", function () { i = (i + 1) % scenes.length; show(scenes[i], true); });
      return;
    }
    pause.hidden = false;
    pause.addEventListener("click", function () {
      paused = !paused;
      pause.setAttribute("aria-pressed", String(paused));
      pause.textContent = paused ? "Play" : "Pause";
    });
    show(scenes[0], true);
    onVisible($("term"), play);
  })();

  /* --------------------------------- flow --------------------------------- */
  (function () {
    var flow = $("flow"), steps = read("flow-data");
    if (!flow || !steps) return;
    var pkt = $("pkt"), pktText = $("pkt-text");
    var status = $("status"), statusText = $("status-text"), deliv = $("deliv");
    var capTitle = $("cap-title"), capText = $("cap-text"), cap = $("flow-cap");
    var tabs = Array.prototype.slice.call(flow.querySelectorAll(".ftab"));
    var play = $("f-play"), prev = $("f-prev"), next = $("f-next");
    var nodes = { client: $("n-client"), worker: $("n-worker"), contract: $("n-contract"), validators: $("n-validators") };
    var CL = [95, 72], WK = [665, 72], CT = [380, 72], VA = [380, 232], MID_L = [230, 72], MID_R = [530, 72];
    // from -> to for the message that travels at each step, who is active, and the contract's state afterwards
    var script = [
      { label: "createJob", from: CL, to: MID_L, active: ["client", "contract"], tone: "gold", st: "OPEN", d: 0, chips: ["idle", "idle", "idle"] },
      { label: "acceptJob", from: WK, to: MID_R, active: ["worker", "contract"], tone: "gold", st: "IN_PROGRESS", d: 0, chips: ["idle", "idle", "idle"] },
      { label: "link 1", from: WK, to: MID_R, active: ["worker", "contract"], tone: "gold", st: "IN_PROGRESS", d: 1, chips: ["idle", "idle", "idle"] },
      { label: "evaluateDelivery", from: CT, to: VA, active: ["contract", "validators"], tone: "warn", st: "NEEDS_REVISION", d: 1, chips: ["MET", "NOT_MET", "MET"] },
      { label: "link 2", from: WK, to: MID_R, active: ["worker", "contract"], tone: "gold", st: "IN_PROGRESS", d: 2, chips: ["idle", "idle", "idle"] },
      { label: "evaluateDelivery", from: CT, to: VA, active: ["contract", "validators"], tone: "ok", st: "VERIFIED", d: 2, chips: ["MET", "MET", "MET"] },
    ];
    var cur = -1, playing = !reduce, timer = null;
    function place(x, y) { pkt.style.transform = "translate(" + x + "px," + y + "px)"; }
    function setChips(states, animate) {
      states.forEach(function (st, k) {
        var chip = $("chip-" + k);
        var apply = function () { chip.setAttribute("data-state", st); chip.querySelector(".v").textContent = st === "idle" ? "-" : st; };
        if (animate && st !== "idle") setTimeout(apply, 900 + k * 330); else apply();
      });
    }
    function go(n, animate) {
      n = (n + script.length) % script.length;
      var s = script[n];
      cur = n;
      flow.setAttribute("data-step", String(n));
      tabs.forEach(function (t, k) {
        t.classList.toggle("done", k < n); t.classList.toggle("on", k === n);
        if (k === n) t.setAttribute("aria-current", "step"); else t.removeAttribute("aria-current");
      });
      Object.keys(nodes).forEach(function (k) { nodes[k].classList.toggle("on", s.active.indexOf(k) >= 0); });
      capTitle.textContent = steps[n].title; capText.innerHTML = steps[n].text;
      pktText.textContent = s.label;
      var wide = s.label.length > 11;
      pkt.querySelector("rect").setAttribute("width", wide ? 148 : 112);
      pkt.querySelector("rect").setAttribute("x", wide ? -74 : -56);
      var doTravel = animate && !reduce;
      // the message travels first, the contract state changes when it arrives
      var arrive = function () {
        status.setAttribute("data-tone", s.tone); statusText.textContent = s.st;
        deliv.textContent = "deliveries " + s.d + " of 2";
        setChips(s.chips, doTravel);
      };
      if (doTravel) {
        pkt.style.transition = "none"; pkt.style.opacity = "0"; place(s.from[0], s.from[1]);
        void pkt.getBoundingClientRect();
        pkt.style.transition = "transform 1.05s cubic-bezier(.5,0,.2,1), opacity .25s"; pkt.style.opacity = "1";
        place(s.to[0], s.to[1]);
        setTimeout(arrive, 950);
        setTimeout(function () { pkt.style.opacity = "0.0"; }, 1500);
      } else { pkt.style.transition = "none"; place(s.to[0], s.to[1]); pkt.style.opacity = "0"; arrive(); }
    }
    function schedule() { clearTimeout(timer); if (playing) timer = setTimeout(function () { go(cur + 1, true); schedule(); }, n_delay()); }
    function n_delay() { return cur === script.length - 1 ? 5200 : 4300; }
    function setPlaying(p) {
      playing = p; clearTimeout(timer);
      play.textContent = p ? "Pause" : "Play"; play.setAttribute("aria-pressed", String(p));
      cap.setAttribute("aria-live", p ? "off" : "polite");
      if (p) schedule();
    }
    tabs.forEach(function (t) { t.addEventListener("click", function () { setPlaying(false); go(parseInt(t.getAttribute("data-i"), 10), true); }); });
    prev.addEventListener("click", function () { setPlaying(false); go(cur - 1, true); });
    next.addEventListener("click", function () { setPlaying(false); go(cur + 1, true); });
    play.addEventListener("click", function () { setPlaying(!playing); });
    go(0, false);
    play.textContent = playing ? "Pause" : "Play"; play.setAttribute("aria-pressed", String(playing));
    if (playing) onVisible(flow, function () { go(0, true); schedule(); });
  })();

  /* ------------------------------ reveal, counters, menu, parallax ------------------------------ */
  (function () {
    var els = Array.prototype.slice.call(document.querySelectorAll(".rv"));
    if (reduce || !("IntersectionObserver" in window)) els.forEach(function (e) { e.classList.add("in"); });
    else {
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
      els.forEach(function (e) { io.observe(e); });
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-count]"), function (el) {
      var to = parseInt(el.getAttribute("data-count"), 10);
      if (reduce || !isFinite(to)) return;
      onVisible(el, function () {
        var t0 = null;
        (function tick(t) {
          if (t0 === null) t0 = t;
          var k = Math.min(1, (t - t0) / 900);
          el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
          if (k < 1) requestAnimationFrame(tick);
        })(performance.now());
      });
    });
    var menu = $("lp-menu"), nav = $("lp-nav");
    if (menu && nav) {
      menu.addEventListener("click", function () { var o = nav.classList.toggle("open"); menu.setAttribute("aria-expanded", String(o)); });
      nav.addEventListener("click", function (e) { if (e.target.tagName === "A") { nav.classList.remove("open"); menu.setAttribute("aria-expanded", "false"); } });
    }
    var glow = document.querySelector(".hero-glow");
    if (glow && !reduce) {
      var tick = false;
      window.addEventListener("scroll", function () {
        if (tick || window.scrollY > 900) return; tick = true;
        requestAnimationFrame(function () { glow.style.transform = "translate3d(0," + (window.scrollY * 0.12).toFixed(1) + "px,0)"; tick = false; });
      }, { passive: true });
    }
  })();

  /* ---------------------------- hero: one job, illustrated ---------------------------- */
  (function () {
    var hv = $("hv"); if (!hv) return;
    var pill = $("hv-pill"), cap = $("hv-cap"), deliv = $("hv-deliv"), rcpt = $("hv-rcpt"), val = $("hv-val"), link = $("hv-link");
    var client = $("hv-client"), worker = $("hv-worker");
    var lis = Array.prototype.slice.call($("hv-crit").children);
    var S = [
      { pill: "OPEN", cap: "The client writes the terms and the criteria.", c: 1, w: 0, d: 0, r: "", v: "", met: 0 },
      { pill: "IN_PROGRESS", cap: "A worker accepts the job.", c: 1, w: 1, d: 0, r: "", v: "", met: 0, run: 1 },
      { pill: "IN_PROGRESS", cap: "The worker delivers a link. The receipt is PENDING.", c: 0, w: 1, d: 1, r: "receipt PENDING", v: "", met: 0, run: 1 },
      { pill: "IN_PROGRESS", cap: "Validators judge each criterion.", c: 0, w: 0, d: 1, r: "receipt PENDING", v: "work", met: 3, stag: 1 },
      { pill: "VERIFIED", cap: "Every criterion is met: the job is final.", c: 0, w: 0, d: 1, r: "receipt VERIFIED", v: "done", met: 3, ok: 1 }
    ];
    var timers = [], cur = 4, started = false;
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function show(n) {
      clear(); cur = n; var s = S[n];
      hv.setAttribute("data-s", String(n)); hv.setAttribute("data-tone", s.ok ? "ok" : "");
      pill.textContent = s.pill; cap.textContent = s.cap; rcpt.textContent = s.r;
      client.classList.toggle("on", !!s.c); worker.classList.toggle("on", !!s.w);
      deliv.classList.toggle("on", !!s.d);
      val.className = "hv-val" + (s.v ? " " + s.v : "");
      link.classList.remove("go"); if (s.run && !reduce) { void link.offsetWidth; link.classList.add("go"); }
      lis.forEach(function (li, i) {
        var on = i < s.met;
        if (s.stag && !reduce) { li.classList.remove("met"); timers.push(setTimeout(function () { li.classList.add("met"); }, 500 + i * 650)); }
        else li.classList.toggle("met", on);
      });
    }
    show(4);
    if (reduce) return;
    function next() { show((cur + 1) % S.length); timers.push(setTimeout(next, cur === 3 ? 3000 : cur === 4 ? 3600 : 2400)); }
    onVisible(hv, function () { started = true; show(0); timers.push(setTimeout(next, 2400)); });
  })();
})();
