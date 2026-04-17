var expectedPdfSha = null;

async function lookup(token) {
    var res = document.getElementById("result");
    var panel = document.getElementById("panel");
    res.hidden = false;
    panel.className = "card";
    document.getElementById("match-card").hidden = true;
    document.getElementById("match-result").textContent = "";
    document.getElementById("match-result").className = "muted small";
    expectedPdfSha = null;
    document.getElementById("status").textContent = "Looking up\u2026";
    var ids = ["issuer","recipient","period","cpe","sessions","issued","pdfsha","signsha"];
    for (var i = 0; i < ids.length; i++) {
        document.getElementById(ids[i]).textContent = "";
    }
    var r, d;
    try {
        r = await fetch("/api/verify/" + encodeURIComponent(token));
        d = await r.json().catch(function () { return {}; });
    } catch (e) {
        panel.className = "card bad";
        document.getElementById("status").textContent = "Network error \u2014 please try again";
        return;
    }
    if (r.status === 404 || !d.valid && r.status !== 200) {
        panel.className = "card bad";
        document.getElementById("status").textContent =
            r.status === 404 ? "No such certificate" : "Lookup failed (" + r.status + ")";
        return;
    }
    panel.className = "card " + (d.state === "revoked" ? "bad" : "ok");
    document.getElementById("status").textContent =
        d.state === "revoked" ? "REVOKED" : "Token is registered \u2014 confirm the PDF below";
    document.getElementById("issuer").textContent = d.issuer || "";
    document.getElementById("recipient").textContent = d.recipient || "";
    document.getElementById("period").textContent =
        (d.period_start || "") + " \u2014 " + (d.period_end || "") + " (" + (d.period_yyyymm || "") + ")";
    document.getElementById("cpe").textContent = d.cpe_total + " CPE";
    document.getElementById("sessions").textContent = d.sessions_count;
    document.getElementById("issued").textContent = d.issued_at || "";
    document.getElementById("pdfsha").textContent = d.pdf_sha256 || "(pending)";
    document.getElementById("signsha").textContent = d.signing_cert_sha256 || "(pending)";
    if (d.state === "revoked") {
        document.getElementById("rev-dt").hidden = false;
        document.getElementById("rev-dd").hidden = false;
        document.getElementById("rev-dd").textContent =
            d.revoked_at + " \u2014 " + (d.revocation_reason || "");
    } else if (d.pdf_sha256) {
        expectedPdfSha = d.pdf_sha256.toLowerCase();
        document.getElementById("match-card").hidden = false;
    }
}

async function sha256Hex(arrayBuffer) {
    var h = await crypto.subtle.digest("SHA-256", arrayBuffer);
    return Array.from(new Uint8Array(h)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function verifyPdf(file) {
    var out = document.getElementById("match-result");
    out.className = "muted small";
    out.textContent = "Computing SHA-256\u2026";
    try {
        var buf = await file.arrayBuffer();
        var got = await sha256Hex(buf);
        if (!expectedPdfSha) {
            out.textContent = "No registered PDF hash to compare against.";
            return;
        }
        if (got === expectedPdfSha) {
            out.className = "match-ok";
            out.setAttribute("role", "status");
            out.setAttribute("aria-label", "Match: this PDF matches the registered certificate");
            out.textContent = "\u2713 This PDF matches the certificate registered under that token.";
        } else {
            out.className = "match-bad";
            out.setAttribute("role", "alert");
            out.setAttribute("aria-label", "Mismatch: this PDF does not match the registered certificate");
            out.textContent = "\u26A0 This PDF does NOT match. The token is registered, but the PDF you uploaded is not the one we issued. Computed: " + got;
        }
    } catch (e) {
        out.className = "match-bad";
        out.textContent = "Could not read the file: " + (e && e.message || "unknown error");
    }
}

var pdfInput = document.getElementById("pdf-input");
var drop = document.getElementById("drop");
pdfInput.addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) verifyPdf(e.target.files[0]);
});
["dragenter","dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
        e.preventDefault(); drop.classList.add("drag");
    });
});
["dragleave","drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
        e.preventDefault(); drop.classList.remove("drag");
    });
});
drop.addEventListener("drop", function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) verifyPdf(f);
});

document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = new FormData(e.target).get("t").trim();
    history.replaceState(null, "", "?t=" + encodeURIComponent(t));
    lookup(t);
});

var urlTok = new URLSearchParams(location.search).get("t");
if (urlTok) {
    document.querySelector("input[name=t]").value = urlTok;
    lookup(urlTok);
}
