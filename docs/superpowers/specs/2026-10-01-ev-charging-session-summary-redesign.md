# EV charging session page — summary + chart redesign

Status: agreed with the owner 2026-10-01, after a live look at PR C (#55). Amends the "/charging/sessions/$sessionId"
UI section of [Phase 4 design](./2026-09-30-ev-charging-phase4-design.md). Session page only; `/charging/economy`
follows in its own PR once this one has been seen live.

## Why

Four equal cards with a small label and a number didn't say what the numbers mean or whether the timing was good:
"Direkt vid inkoppling" was unexplained, and nothing showed where the actual cost sat between the best and worst
possible. The chart had two y-axes (kW + öre), which the dataviz guidance treats as the first chart mistake.

Reference patterns (owner asked for Vercel / Linear / Supabase-style data pages): neutral cards with colour only on
the comparison (green = good, red = bad), every number paired with its reference point, and a **bullet / range bar**
(Stephen Few) for "actual vs best vs worst".

## Summary block (replaces `SessionEconomyFigures` for an included session)

One card, top to bottom:

1. **Hero row.** Label "Kostnad", the actual cost as the page's one hero figure (≥48 px on desktop, proportional
   figures), with "{kWh} kWh · {kr/kWh} kr/kWh" beside/below it. On the right a **verdict pill** (icon + label, never
   colour alone):

   | Score | Pill | Token |
   |---|---|---|
   | ≥ 0,67 | "Bra tajming" + check icon | `--success` |
   | 0,33 – < 0,67 | "Okej tajming" + minus icon | `--warning` |
   | < 0,33 | "Dyr tajming" + alert icon | `--destructive` |
   | null (spread below the D1 threshold) | "Inget att välja mellan" + neutral icon | muted |

2. **Verdict sentence**, plain language, built from the figures. Templates:
   - "{left} dyrare än billigaste möjliga, men {saved} billigare än att ladda direkt vid inkoppling."
   - saved < 0: "{left} dyrare än billigaste möjliga och {|saved|} dyrare än att ladda direkt vid inkoppling."
   - left ≈ 0 (< 0,50 kr): "Nästan billigast möjliga — {saved} billigare än att ladda direkt vid inkoppling."
   - score null: "Alla laddtider medan bilen var inkopplad hade kostat ungefär lika (spann {spread})."

3. **Range bar** ("Pristajming {score} %"), hidden when the score is null. A horizontal track from **billigast**
   (left, labelled with its kronor) to **dyrast** (right, labelled), tinted good → bad (a low-opacity
   `--success` → `--warning` → `--destructive` track; the kronor labels and markers carry the meaning, not the tint).
   Two markers on the track: **Faktiskt** (solid, labelled with its kronor) and **Direkt** (outline, labelled). Markers
   that would collide stack their labels above/below. Position = (value − cheapest) ÷ (dearest − cheapest).

4. **Two explained delta tiles** under a divider:
   - "Sparat mot direktladdning" — signed kronor (`formatSignedSek`), green when > 0, red when < 0, neutral at 0,
     with an arrow icon; explainer "Om bilen laddat med full fart från {plug-in time} ({rate} kW) tills den var klar."
   - "Kvar att hämta" — kronor (never negative), neutral ink (it is an opportunity, not a failure); explainer "Om
     laddningen lagts på de billigaste perioderna medan bilen var inkopplad: {windows}." `{windows}` comes from
     `optimalSchedule`: merge adjacent pieces into runs; one or two runs → "00:00–06:30" / "00:00–02:00 och
     05:00–06:30"; more → "{n} perioder mellan {first start} och {last end}". Times in Stockholm, weekday prefix when the
     run is on another day than the plug-in.

Colour rules: coloured *text* only where it clears 4,5:1 against the card in that theme (compute it); otherwise
colour the icon / pill background and keep the text in foreground ink. Status tokens mean good/bad only.

Excluded sessions keep today's behaviour (cost + the exclusion `Alert`, no verdict/bar/deltas). Estimated cost keeps
its "≈".

## Chart (`SessionPriceChart`) — two aligned panels

- **Top panel: spot price** (öre/kWh incl. moms) as the step line on its own y-axis; the cheapest-schedule runs
  softly shaded behind the line, so the reader sees "the cheap stretch" on the price itself.
- **Bottom panel: energy** (kW) — actual bars + the cheapest-schedule outline, its own y-axis.
- One shared time axis (under the bottom panel), the plug-in window rules spanning both panels, one hover/keyboard
  crosshair + popover across both (the popover keeps today's content). The zero line stays on the price panel.
- Heights: price ≈ 40 %, energy ≈ 60 % of the chart; total height unchanged-ish, responsive width as today.
- Fix while there: zero-kWh intervals draw nothing (today a 1-px orange line runs along the baseline through idle
  hours).
- Keep: the sr-only table, keyboard path, legend (now per panel or one shared legend), ≥3:1 series contrast.

## Out of scope / next

- `/charging/economy` tiles get the same verdict + explained deltas in a follow-up PR.
- A "did I plug in at a good time of day" metric (vs the day's prices) — later.
