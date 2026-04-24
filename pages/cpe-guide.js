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
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener("click", function () {
            var target = this.dataset.tab;
            for (var j = 0; j < tabs.length; j++) {
                tabs[j].classList.toggle("active", tabs[j] === this);
                tabs[j].setAttribute("aria-selected", tabs[j] === this ? "true" : "false");
            }
            var panels = document.querySelectorAll(".tab-panel");
            for (var j = 0; j < panels.length; j++) {
                panels[j].classList.toggle("active", panels[j].id === "panel-" + target);
            }
        });
    }
})();
