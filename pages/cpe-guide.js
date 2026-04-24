(function () {
    var params = new URLSearchParams(location.search);
    var name = params.get("name") || "";
    var hours = params.get("hours") || "";
    var sessions = params.get("sessions") || "";
    var certUrl = params.get("certUrl") || "";
    var downloadUrl = params.get("downloadUrl") || "";

    if (name) {
        document.getElementById("field-bar").hidden = false;
        document.getElementById("f-name").textContent = name;
        document.getElementById("f-hours").textContent = hours + " CPE";
        document.getElementById("f-sessions").textContent = sessions + " sessions";
    }

    var hourEls = ["ct-hours", "i2-hours", "ia-hours"];
    for (var i = 0; i < hourEls.length; i++) {
        var el = document.getElementById(hourEls[i]);
        if (el && hours) { el.textContent = hours; el.dataset.value = hours; }
    }

    var dateEls = ["ct-dates", "i2-dates", "ia-dates"];
    for (var i = 0; i < dateEls.length; i++) {
        var el = document.getElementById(dateEls[i]);
        if (el && name) { el.textContent = name; el.dataset.value = name; }
    }

    var verifyEls = ["ct-verify", "i2-verify", "ia-verify"];
    for (var i = 0; i < verifyEls.length; i++) {
        var el = document.getElementById(verifyEls[i]);
        if (el && certUrl) { el.textContent = certUrl; el.dataset.value = certUrl; }
    }

    var dlEls = ["ct-dl", "i2-dl", "ia-dl"];
    for (var i = 0; i < dlEls.length; i++) {
        var el = document.getElementById(dlEls[i]);
        if (el && downloadUrl) el.href = downloadUrl;
    }

    document.addEventListener("click", function (e) {
        var btn = e.target.closest(".copy-btn");
        if (!btn) return;
        var val = btn.dataset.value || btn.textContent;
        if (!val || val === "—") return;
        navigator.clipboard.writeText(val).then(function () {
            var orig = btn.textContent;
            btn.textContent = "Copied!";
            btn.classList.add("copied");
            setTimeout(function () {
                btn.textContent = orig;
                btn.classList.remove("copied");
            }, 1500);
        });
    });

    var tabs = document.querySelectorAll(".tab");
    function activateTab(tab) {
        var target = tab.dataset.tab;
        for (var j = 0; j < tabs.length; j++) {
            tabs[j].classList.toggle("active", tabs[j] === tab);
            tabs[j].setAttribute("aria-selected", tabs[j] === tab ? "true" : "false");
            tabs[j].setAttribute("tabindex", tabs[j] === tab ? "0" : "-1");
        }
        var panels = document.querySelectorAll(".tab-panel");
        for (var j = 0; j < panels.length; j++) {
            var isActive = panels[j].id === "panel-" + target;
            panels[j].classList.toggle("active", isActive);
            panels[j].hidden = !isActive;
        }
        tab.focus();
    }
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].setAttribute("tabindex", tabs[i].classList.contains("active") ? "0" : "-1");
        tabs[i].addEventListener("click", function () { activateTab(this); });
        tabs[i].addEventListener("keydown", function (e) {
            var idx = Array.prototype.indexOf.call(tabs, this);
            if (e.key === "ArrowRight") { activateTab(tabs[(idx + 1) % tabs.length]); e.preventDefault(); }
            else if (e.key === "ArrowLeft") { activateTab(tabs[(idx - 1 + tabs.length) % tabs.length]); e.preventDefault(); }
            else if (e.key === "Home") { activateTab(tabs[0]); e.preventDefault(); }
            else if (e.key === "End") { activateTab(tabs[tabs.length - 1]); e.preventDefault(); }
        });
    }
})();
