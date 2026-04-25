# Phase D: Dashboard Visual Polish & Behavioral UX

## Context

Brainstorm, plan, and implement a visual polish + behavioral UX overhaul of the
user dashboard (`pages/dashboard.html`, `pages/dashboard.js`,
`pages/dashboard.css`). This phase focuses on making the dashboard look and
*feel* like a premium professional credential portfolio — not a gamified app,
not generic SaaS.

**Phase B (PR #78) shipped:** card ordering, getting-started progress bar,
state-based card visibility, settings accordion, toast system, empty states,
`prefers-reduced-motion` fallback.

**Phase C (PRs #79–80) shipped:** two-column CSS grid, interactive calendar
(click → inline detail), cert card 2-column grid, dashboard modes
(daily/review/onboarding), attendance expand/collapse, last-updated indicator,
skip link, ARIA landmarks, keyboard navigation, type scale audit (min 11px),
card entrance animations.

**Phase D goes deeper into polish, microcopy, and behavioral psychology.**
The dashboard is functionally complete — this phase makes it *excellent*.

---

## Design Principles

1. **Professional credential portfolio.** The audience is CISSP/CISM holders
   who take certification seriously. Every pixel should reinforce that this is
   a trusted, auditable system — not a toy.
2. **Ownership framing.** Use "your" and "you've" throughout. The user should
   feel this is *their* professional record, not an admin view of their data.
3. **Endowed progress.** Never show literal zero. Registration is step 1.
   Frame every empty state as the beginning of a sequence, not the absence of
   data. (Nunes & Drèze 2006)
4. **Loss aversion for retention.** Once a streak exceeds 3 days, frame it as
   something to protect ("Don't break your 7-day streak") rather than something
   to grow. (Tversky & Kahneman 1991)
5. **Quiet professionalism.** No confetti, no emoji celebrations, no badge
   unlocks. Milestones are acknowledged with warm gold accents and understated
   copy. Think law firm, not Duolingo.
6. **Dark mode is the hero.** Most cybersecurity professionals prefer dark
   mode. Light mode must work, but dark mode gets the premium treatment:
   subtle gradients, glow effects, architectural framing.

---

## 1. Microcopy Overhaul

Rewrite all user-facing text using ownership framing, endowed progress, and
loss aversion. Research basis: Burnkrant & Unnava (1995), Packard et al.
(2017), Nunes & Drèze (2006), Kivetz et al. (2006), Tversky & Kahneman
(1991).

### Stat Labels
| Current | New |
|---------|-----|
| `CPE earned` | `CPE you've earned` |
| `current streak` | `your streak` |
| `longest streak` | `your best` |
| `--` (loading) | `···` (or skeleton shimmer) |

### Streak Display Logic
- **Zero:** Hide the stat blocks entirely. Show nothing rather than "0".
  When the user has no attendance at all, the getting-started card handles
  motivation. Do not render demotivating zeros.
- **1–3 days:** Show the number. Label: `your streak`.
- **4+ days:** Show the number. Label changes to `keep it going` or
  stat-label becomes: `Don't break your {N}-day streak` rendered as a
  subtle line below the stat value in `--warn` color.

### Empty States
| Current | New |
|---------|-----|
| `No attendance records yet. The Daily Threat Briefing streams weekdays at 8:00 AM ET. Post any 3+ character message in the live chat to earn 0.5 CPE per session.` | `Your attendance log starts with your first briefing. The Daily Threat Briefing streams weekdays at 8:00 AM ET — post any message in the live chat to start earning CPE.` |
| `No certificates yet. Certificates are issued at the start of each month for the prior month's attendance. Attend your first briefing and your first cert will arrive next month.` | `Your first certificate will appear here after your first month of attendance. Certificates are signed and delivered at the start of each month.` |
| Calendar: `(hidden when 0)` | `This month is ready for your first check-in` |

### Today Card States
| State | Current | New |
|-------|---------|-----|
| Live, pending | `Waiting for qualifying message` | `The briefing is live — post your code in chat to earn credit` |
| Credited | `Credited — 0.5 CPE recorded for this session.` | `You've earned 0.5 CPE for today's briefing` |
| Ended, missed | `This session ended without credit...` | `Today's briefing has ended. Your next chance to earn credit is tomorrow's session.` |

### Cert Card Copy
| Current | New |
|---------|-----|
| `Open certificate ↗` | `View your certificate ↗` |
| `Signing…` (pending state) | `Preparing your signed PDF` |

---

## 2. Stats Card Visual Upgrade

The stats card is the emotional center of the dashboard. It should feel like
a portfolio summary, not a KPI tile.

### Changes
- **Larger stat values:** Increase from `2rem` to `2.5rem` (clamp for mobile).
  Use `font-variant-numeric: tabular-nums lining-nums` for alignment.
  Add `letter-spacing: -0.03em` for tighter, more editorial feel.
- **Uppercase stat labels:** `font-size: 0.75rem; letter-spacing: 0.1em;
  text-transform: uppercase;` — reads like a financial dashboard.
- **Dividers between stats:** Vertical `1px solid var(--border)` separators
  between stat blocks on desktop. Use `border-left` on 2nd/3rd stat-block.
  Remove on mobile (column layout).
- **Review mode emphasis:** In review mode, the stats card gets a subtle
  gradient background:
  ```css
  [data-mode="review"] #stats-card {
      background: linear-gradient(135deg,
          light-dark(rgba(0,87,216,0.03), rgba(124,195,255,0.05)),
          transparent 50%);
  }
  ```

### Streak-Specific Display
When streak > 3, add a subtle line below the streak stat:
```html
<div class="streak-nudge">keep it going — don't break your streak</div>
```
Styled: `font-size: 11px; color: var(--warn); font-weight: 500;`

When streak is 0 and user has no attendance, hide `streak-current-wrap` and
`streak-best-wrap` entirely (already partially done — ensure consistent).

---

## 3. Card Visual Hierarchy

### Subtle Background Gradient on Body
Add atmospheric depth to the page:
```css
body {
    background:
        radial-gradient(ellipse at top left,
            light-dark(rgba(0,87,216,0.04), rgba(124,195,255,0.06)),
            transparent 40%),
        var(--bg);
}
```
This gives the page a sense of depth without being distracting.

### Card Border Refinement
**Note:** `.card` is defined in `style.css` and shared across all pages.
These changes are site-wide improvements that benefit every page. If that
scope is too broad, scope to `.dashboard-grid .card` instead.

- Soften the border and add a subtle shadow for depth:
  ```css
  .card {
      border: 1px solid light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.06));
      box-shadow: 0 1px 3px light-dark(rgba(0,0,0,0.04), rgba(0,0,0,0.3));
  }
  ```
- Dark mode hover gets a faint glow (already partially exists — refine):
  ```css
  @media (prefers-color-scheme: dark) {
      .card:hover {
          border-color: rgba(124, 195, 255, 0.12);
          box-shadow: 0 2px 12px rgba(124, 195, 255, 0.04);
      }
  }
  ```

### Card Type Differentiation
- **Live-action cards** (today, getting-started): Keep the `border-left: 4px`
  treatment. These are transient and time-sensitive.
- **Data cards** (stats, calendar, attendance, certs): No left border. Use the
  subtle shadow treatment above. These are the permanent record.
- **Settings cards** (inside accordion): Lighter background
  `var(--card-alt)` to visually recede.

---

## 4. Calendar Visual Improvements

### Heat-Map Intensity
Currently all credited days look the same. Add visual weight for days with
both attendance credit AND a per-session cert:
```css
.cal-cell.has-credit.has-cert {
    background: light-dark(
        linear-gradient(135deg, #d1fae5, #bbf7d0),
        linear-gradient(135deg, #0e3a1a, #164a2a)
    );
}
```
This requires cross-referencing cert data with attendance dates in
`renderCalendar()`. The `certs` array from the API response contains
`period_yyyymm` and `cert_kind`. For per-session certs, match against
`attendance[].scheduled_date`. For bundled certs, match against month.
Add a `has-cert` class to qualifying cells. Store certs data in a module-
level variable alongside `calData` so `renderCalendar()` can access it.

### Today Cell Enhancement
Make today's cell more prominent:
```css
.cal-cell.cal-today {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    background: light-dark(rgba(0,87,216,0.04), rgba(124,195,255,0.06));
}
```

### Calendar Monthly Summary Upgrade
Replace the plain text summary with a more informative line:
```
8 days attended · 4.0 CPE earned this month
```
This requires summing CPE from attendance data for the displayed month.

---

## 5. Certificate Cards Polish

### Document Treatment
Give cert cards a premium "document" feel:
```css
.cert-row {
    background:
        linear-gradient(135deg,
            light-dark(rgba(0,87,216,0.03), rgba(124,195,255,0.04)),
            transparent 40%),
        var(--card);
}
```

### Period Display
Make the period (e.g., "April 2026") more prominent:
```css
.cert-period {
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: -0.01em;
}
```

### Action Icons
The LinkedIn / OB / CPE Guide icons currently feel disconnected. Group them
with a subtle separator:
```css
.cert-actions {
    border-top: 1px solid var(--border);
    padding-top: 10px;
    margin-top: 12px;
}
```

---

## 6. Renewal Tracker Promotion

The renewal tracker is currently buried inside the Settings accordion. For
users who have configured it, it should be visible on the main dashboard —
it's the most goal-oriented feature and the strongest motivator.

### Changes
- **If configured:** Render a compact renewal summary card *above* the
  dashboard grid (after stats card, before the two-column area). Show:
  cert name, progress bar, CPE fraction, days remaining.
- **If not configured:** Show a subtle prompt card in the same position:
  "Track your CISSP/CISM renewal progress — [Set up tracker]" that opens
  the settings accordion.
- **Keep the full form in Settings** for editing/removal.
- This is a **medium** change: requires duplicating the compact display
  outside the accordion and conditionally rendering based on
  `email_prefs.renewal_tracker`.

---

## 7. Attendance History Polish

### Row Styling
- Increase border radius from `6px` to `8px` for consistency with cards.
- Add `transition: background-color 0.15s ease` for smoother expand.
- Expanded state gets a subtle background shift:
  ```css
  .att-row.att-expanded {
      background: light-dark(#f8fbff, #101826);
      border-color: light-dark(#cdd9e8, var(--border-strong));
  }
  ```

### Evidence Hash Display
When expanded, the evidence hash currently shows in a monospace span.
Improve with a subtle "verified" visual cue:
- Prefix with a small shield icon (SVG inline, `width: 14px`).
- Use `var(--ok-soft-text)` color for the hash.
- Add `title="SHA-256 hash of your first chat message — independently
  verifiable"` for context.

### Per-Session Cert Button
The "Request per-session cert" button should feel less like a primary action
and more like a secondary option:
```css
.att-ps-btn {
    font-size: 12px;
    padding: 6px 10px;
    min-height: 36px;
    border: 1px solid var(--border);
    color: var(--muted);
}
.att-ps-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
}
```

---

## 8. Typography & Spacing System

### Formal Type Scale
Establish a 5-step scale and apply consistently:

| Token | Size | Use |
|-------|------|-----|
| `--text-xs` | `0.75rem` (12px) | Meta text, timestamps, hints |
| `--text-sm` | `0.8125rem` (13px) | Secondary labels, descriptions |
| `--text-base` | `1rem` (16px) | Body text, primary labels |
| `--text-lg` | `1.125rem` (18px) | Card headings (h2 inside cards) |
| `--text-xl` | `1.5rem` (24px) | Page section headings |
| `--text-2xl` | `2.5rem` (40px) | Stat hero values |

Define these as CSS custom properties in `style.css` and reference them
throughout `dashboard.css`. Do NOT use raw `px` or `rem` values for font
sizes — always use the token.

### Spacing Tokens
Define and use consistently:
```css
:root {
    --space-xs: 4px;
    --space-sm: 8px;
    --space-md: 12px;
    --space-lg: 16px;
    --space-xl: 24px;
    --space-2xl: 32px;
}
```

### Card Padding Consistency
Currently cards use `0.85rem 1rem` on mobile and `1rem 1.25rem` on desktop.
Standardize:
- All cards: `var(--space-lg) var(--space-xl)` (16px 24px) on desktop.
- Mobile: `var(--space-md) var(--space-lg)` (12px 16px).

---

## 9. Micro-Interactions & Transitions

### Card Hover State (Desktop Only)
Add a subtle lift on hover for interactive cards:
```css
@media (hover: hover) {
    .att-row:hover, .cert-row:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px light-dark(rgba(0,0,0,0.06), rgba(0,0,0,0.3));
        transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
}
```

### Smooth Expand/Collapse
Replace the instant `display: none/block` toggle on attendance details
with a CSS `max-height` transition. This requires changing the existing
`.att-detail { display: none }` / `.att-expanded .att-detail { display: block }`
to use `max-height` instead (you cannot transition `display`):
```css
.att-detail {
    display: block;
    max-height: 0;
    overflow: hidden;
    opacity: 0;
    transition: max-height 0.25s ease, opacity 0.2s ease, padding 0.2s ease;
    padding-top: 0;
    margin-top: 0;
    border-top: none;
}
.att-row.att-expanded .att-detail {
    max-height: 300px;
    opacity: 1;
    padding-top: 8px;
    margin-top: 8px;
    border-top: 1px solid var(--border);
}
```

### Calendar Cell Transition
Add a subtle press effect on calendar cells:
```css
.cal-cell.has-credit:active {
    transform: scale(0.97);
    transition: transform 0.1s ease;
}
```

### Stat Value Count-Up
When stats load, animate the CPE number from 0 to its value using a
simple JS counter:
```js
function animateValue(el, end, duration) {
    var start = 0, startTime = null;
    function step(ts) {
        if (!startTime) startTime = ts;
        var progress = Math.min((ts - startTime) / duration, 1);
        el.textContent = (progress * end).toFixed(1);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}
```
Duration: 600ms. Only run on first load, not on refresh.
Respect `prefers-reduced-motion`: skip animation, show final value.

---

## 10. Dark Mode Premium Treatment

The dark mode palette is already well-constructed. Enhance it:

### Page-Level Atmosphere
```css
@media (prefers-color-scheme: dark) {
    body {
        background:
            radial-gradient(ellipse at 20% 0%,
                rgba(124, 195, 255, 0.05), transparent 50%),
            var(--bg);
    }
}
```

### Card Glow on Focus
```css
@media (prefers-color-scheme: dark) {
    .card:focus-within {
        box-shadow: 0 0 0 1px rgba(124, 195, 255, 0.15),
                    0 0 20px rgba(124, 195, 255, 0.03);
    }
}
```

### Stats Accent Glow
```css
@media (prefers-color-scheme: dark) {
    .stat-value {
        text-shadow: 0 0 20px rgba(124, 195, 255, 0.15);
    }
}
```

### Footer Gradient Border (Refine Existing)
The existing `border-image` gradient is good. Add a fade-in:
```css
@media (prefers-color-scheme: dark) {
    .site-footer {
        border-top: none;
        border-image: linear-gradient(90deg,
            transparent 5%,
            rgba(124, 195, 255, 0.15) 50%,
            transparent 95%) 1;
    }
}
```

---

## 11. Mobile Polish

### Touch Target Audit
Ensure all interactive elements meet 44×44px minimum (iOS HIG + WCAG 2.5.5):
- Calendar nav buttons: already `min-width: 32px` → increase to `44px`.
- Calendar appeal CTA: currently `11px` font, no padding → wrap in a
  larger tap target.
- Cert action icons: already `40×40px` → increase to `44×44px`.

### Sticky Last-Updated Bar
On mobile, make the last-updated bar sticky at the top so the user always
knows data freshness:
```css
@media (max-width: 639px) {
    .last-updated-bar {
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--bg);
        padding: 6px 0;
        border-bottom: 1px solid var(--border);
    }
}
```

### Swipe Hint on Calendar
Add a subtle horizontal scroll hint on very narrow screens (< 360px):
```css
@media (max-width: 359px) {
    .cal-grid {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
    }
}
```

---

## Constraints

- **Zero npm dependencies.** No framework, no build step. Vanilla JS/CSS only.
- **No API changes.** The `/api/me/[token]` response has all the data needed.
  Renewal tracker promotion reads from `email_prefs.renewal_tracker` which is
  already in the response.
- **CSP `script-src 'self'`** — no inline JS.
- **Must not regress Phase B/C features.** Getting started, state-based
  visibility, settings accordion, toast system, two-column grid, dashboard
  modes, interactive calendar, attendance expand/collapse, card animations —
  all stay.
- **Dark/light theme** via `light-dark()` CSS functions. Any new color must
  use this pattern.
- **`prefers-reduced-motion`** — all new animations must have a `reduce`
  fallback.
- **421+ tests must keep passing** (frontend is untested, but backend must
  not break).
- **Accessibility:** maintain all ARIA attributes, keyboard navigation, skip
  links, focus indicators from Phase C. New interactive elements need the
  same treatment.

## Approach

Implement in this order (each section is independently shippable):

1. **Microcopy overhaul** (§1) — JS string changes only, no CSS. Fast.
2. **Typography & spacing tokens** (§8) — CSS custom properties, then
   find-and-replace raw values. Foundation for everything else.
3. **Card visual hierarchy** (§3) — background gradient, card shadows,
   type differentiation. Sets the premium feel.
4. **Stats card upgrade** (§2) — larger values, separators, streak logic.
5. **Dark mode premium** (§10) — atmosphere, glow effects.
6. **Attendance & cert polish** (§5, §7) — document treatment, row styling.
7. **Calendar improvements** (§4) — heat map, summary upgrade.
8. **Micro-interactions** (§9) — transitions, hover states, count-up.
9. **Renewal tracker promotion** (§6) — medium complexity, new DOM.
10. **Mobile polish** (§11) — sticky bar, touch targets, swipe.

Run `codex exec --model gpt-5.4 --full-auto` review after each major section
for a second opinion.

## Research References

- Nunes, J. C., & Drèze, X. (2006). *The Endowed Progress Effect.* JCR.
- Kivetz, R., Urminsky, O., & Zheng, Y. (2006). *Goal-Gradient Hypothesis
  Resurrected.* JMR.
- Tversky, A., & Kahneman, D. (1991). *Loss Aversion in Riskless Choice.* QJE.
- Burnkrant, R. E., & Unnava, H. R. (1995). *Self-Referencing on Persuasion.* JCR.
- Packard, G., et al. (2017). *Second Person Pronouns Enhance Consumer
  Involvement.* J. Interactive Marketing.
- Cialdini, R. B., & Goldstein, N. J. (2004). *Social Influence.* Ann. Rev. Psych.
- Schultz, P. W., et al. (2007). *Constructive, Destructive, and Reconstructive
  Power of Social Norms.* Psychological Science.

## Files to Touch

- `pages/dashboard.html` — renewal tracker promotion, evidence hash shield icon
- `pages/dashboard.js` — microcopy rewrites, streak logic, count-up animation,
  calendar summary upgrade, renewal tracker compact display
- `pages/dashboard.css` — type tokens, spacing tokens, card hierarchy, stats
  upgrade, dark mode premium, transitions, mobile polish
- `pages/style.css` — type scale tokens, spacing tokens, body gradient,
  card shadow defaults
- `CLAUDE.md` — update Known gaps with Phase D changes
