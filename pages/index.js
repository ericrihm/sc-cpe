(function () {
    try {
        var raw = localStorage.getItem("sc_cpe_session");
        if (!raw) return;
        var s = JSON.parse(raw);
        if (!s.token || !s.saved_at) return;
        if (Date.now() - s.saved_at > 30 * 24 * 60 * 60 * 1000) return;
        var card = document.getElementById("return-card");
        if (card) {
            var nameEl = document.getElementById("return-name");
            if (nameEl && s.name) nameEl.textContent = s.name;
            card.hidden = false;
        }
    } catch (e) {}
})();

var ERROR_COPY = {
    invalid_email: "That email address doesn\u2019t look right.",
    invalid_name: "Legal name must be 2\u2013100 letters.",
    legal_name_attestation_required: "Please tick the legal-name attestation.",
    tos_required: "Please accept the Terms of Service and Privacy Policy.",
    captcha_failed: "Anti-bot challenge failed \u2014 please try again.",
    already_registered: "That email is already registered.",
    invalid_json: "Something went wrong submitting the form.",
};

document.getElementById("f").addEventListener("submit", async function (e) {
    e.preventDefault();
    var submitBtn = e.target.querySelector("button[type=submit]");
    var fd = new FormData(e.target);
    var turnstileToken = fd.get("cf-turnstile-response");
    var err = document.getElementById("err");
    err.hidden = true;
    if (!turnstileToken) {
        err.textContent = "Please complete the anti-bot challenge.";
        err.hidden = false;
        return;
    }
    submitBtn.disabled = true;
    var originalLabel = submitBtn.textContent;
    submitBtn.textContent = "Registering\u2026";
    var body = {
        email: fd.get("email"),
        legal_name: fd.get("legal_name"),
        legal_name_attested: fd.get("legal_name_attested") === "on",
        tos: fd.get("tos") === "on",
        tos_version: "v1",
        turnstile_token: turnstileToken,
    };
    try {
        var r = await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        var data = await r.json();
        if (!r.ok) {
            if (data.error === "already_registered") {
                err.textContent = "";
                var span = document.createElement("span");
                span.textContent = "That email is already registered. ";
                var link = document.createElement("a");
                link.href = "/dashboard.html";
                link.textContent = "Sign in to your dashboard";
                link.style.color = "inherit";
                link.style.textDecoration = "underline";
                var rest = document.createTextNode(" to access your attendance and certificates.");
                err.appendChild(span);
                err.appendChild(link);
                err.appendChild(rest);
            } else {
                err.textContent = ERROR_COPY[data.error] || "Registration failed (" + (data.error || r.status) + ").";
            }
            err.hidden = false;
            return;
        }
        document.getElementById("f").hidden = true;
        document.getElementById("expires").textContent = data.expires_at;
        document.getElementById("ok").hidden = false;
    } catch (x) {
        err.textContent = "Network error \u2014 check your connection and try again.";
        err.hidden = false;
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
    }
});
