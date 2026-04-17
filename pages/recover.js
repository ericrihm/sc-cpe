var ERROR_COPY = {
    invalid_email: "That email address doesn\u2019t look right.",
    captcha_failed: "Anti-bot challenge failed \u2014 please try again.",
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
    submitBtn.textContent = "Sending\u2026";
    try {
        var r = await fetch("/api/recover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: fd.get("email"),
                turnstile_token: turnstileToken,
            }),
        });
        var data = await r.json();
        if (!r.ok) {
            err.textContent = ERROR_COPY[data.error] || "Request failed (" + (data.error || r.status) + ").";
            err.hidden = false;
            return;
        }
        document.getElementById("f").hidden = true;
        if (data.message) document.getElementById("ok-msg").textContent = data.message;
        document.getElementById("ok").hidden = false;
    } catch (x) {
        err.textContent = "Network error \u2014 check your connection and try again.";
        err.hidden = false;
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
    }
});
