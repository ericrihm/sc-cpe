(function () {
    var KEY = "sc-cpe-theme";
    var root = document.documentElement;

    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (_) { }
    if (saved === "dark" || saved === "light") {
        root.setAttribute("data-theme", saved);
    }

    function effective() {
        var stored = null;
        try { stored = localStorage.getItem(KEY); } catch (_) { }
        if (stored === "dark" || stored === "light") return stored;
        return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    function apply(theme) {
        root.setAttribute("data-theme", theme);
        try { localStorage.setItem(KEY, theme); } catch (_) { }
        paintButton();
    }

    function paintButton() {
        var btn = document.getElementById("theme-toggle");
        if (!btn) return;
        var dark = effective() === "dark";
        btn.textContent = dark ? "\u2600" : "\u263E";
        btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
        btn.setAttribute("aria-pressed", dark ? "true" : "false");
        btn.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
    }

    function mount() {
        if (document.getElementById("theme-toggle")) return;
        var btn = document.createElement("button");
        btn.id = "theme-toggle";
        btn.type = "button";
        btn.className = "theme-toggle";
        btn.addEventListener("click", function () {
            apply(effective() === "dark" ? "light" : "dark");
        });
        document.body.appendChild(btn);
        paintButton();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mount);
    } else {
        mount();
    }

    var mq = matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () { paintButton(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
})();
