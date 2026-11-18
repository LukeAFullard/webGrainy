# Quality-of-life plan

Improvements that make webGrainy easier and safer to use day to day. None changes how grains
are measured. Ordered by value; each item lists what to build and how we will know it works.

Status key: ☐ to do · ◐ in progress · ☑ done (with PR link).

---

## 1. Backup reminder and storage status ☑ (batch 1)

**Problem.** Projects are stored only in this browser (IndexedDB). Clearing site data, using a
different browser or computer, or the browser evicting storage loses every photo and result,
with no warning.

**Build.**
- Record when each site was last exported as a `.webgrainy.json` project file.
- In the Site panel: "Last backed up: never / 3 days ago" and a **Back up now** button (the
  existing archive export). Show it as a gentle warning when there are analysed photos that are
  newer than the last backup.
- Show storage use and whether the browser granted persistent storage (`navigator.storage.persisted()`),
  with a one-line explanation of what that means.

**Done when.** A site with new results shows the reminder; backing up clears it; the reminder
reappears after further changes. Tests for the "needs backup" rule.

## 2. Keep the screen awake during analyses ☑ (batch 1)

**Problem.** Cellpose-SAM on a CPU takes minutes per photo. Laptops and phones dim and sleep,
and browsers throttle or pause hidden tabs, so long batches stall.

**Build.** Request a Screen Wake Lock (`navigator.wakeLock.request('screen')`) when a batch
starts; release it when the batch ends or is cancelled; re-request it if the tab becomes
visible again mid-batch. Silently skip where unsupported.

**Done when.** Wake lock is held exactly while a batch runs (unit test with a mocked API;
checked in Chromium).

## 3. "Done" signal for long analyses ☑ (batch 1)

**Problem.** Users switch to other work during long batches and do not know when they finish.

**Build.**
- Tab title shows progress (`(3/10) webGrainy`) and `✓ Done` when finished, while the tab is
  hidden.
- Optional browser notification at the end of batches longer than about a minute (asked for
  only when the user ticks "Notify me when done").

**Done when.** Title updates during a batch and resets when the tab is focused; notification
is only requested after the user opts in.

## 4. Remember analysis settings between visits ☑ (batch 1)

**Problem.** Statistics settings are saved per site, but the analysis settings (model,
CP-SAM weights, scale mode, fine-tuning, advanced) reset to defaults on every reload.

**Build.** Save the analysis settings in the browser (localStorage, versioned and validated
on load; unknown or invalid values fall back to the tested defaults). "Reset analysis settings
to defaults" also clears the saved copy.

**Done when.** Settings survive a reload; corrupted or old saved values cannot break the app
(tests).

## 5. One-page printable site report ☑ (batch 2)

**Problem.** Most users need a single summary for a field report, not several CSV files.

**Build.** *Export → Printable report*: an HTML page laid out for printing / Save as PDF, with
the site name and date, the cumulative curve and size distribution, the key statistics table
(D16/D50/D84 with CIs, Dg, σg, sorting, Wentworth %), sample adequacy, one photo with
outlines per analysed photo (thumbnail), the analysis settings and model, warnings, and the
citation block.

**Done when.** The report opens, prints to A4 on one or two pages, and contains the same
numbers as the summary CSV (test compares them).

## 6. Photo list tools ☑ (batch 2)

**Build.**
- A summary line under the photo list: "8 photos · 6 analysed · 2 not calibrated · 1 failed",
  each part clickable to filter the list.
- Multi-select (checkbox mode) to include/exclude, re-analyse or delete several photos.
- Confirmation (with photo count) before deleting.

**Done when.** Filters and bulk actions work on a site with mixed states (browser check).

## 7. Grain inspector navigation ☑ (batch 2)

**Build.** In the grain inspector: previous / next grain, "largest grain", and "next flagged
grain" (touching the border, inside an exclusion, or unusually elongated), so checking
outlines does not require hunting around the photo.

**Done when.** Buttons move the selection and pan the view to the grain.

## 8. Keyboard shortcuts overlay ☑ (batch 2)

**Build.** Press `?` (or Help → Keyboard shortcuts) to show all shortcuts: tools, zoom/pan,
undo/redo, finish/cancel shape, next/previous photo. Add the missing ones (e.g. `[`/`]` for
previous/next photo, `1`–`9` for tools).

**Done when.** Overlay lists every shortcut that actually works (test derives the list from the
same table the key handler uses).

## 9. Compare sites over time ☑ (batch 2)

**Build.** An optional survey date per site (defaulting to the earliest photo date from EXIF).
In *Compare sites*: "Order by date" and a time-series chart of D16/D50/D84 with confidence
intervals.

**Done when.** Sites with dates plot in order; sites without a date are listed separately.

---

## Not planned (and why)

- **Automatic ruler detection.** Valuable, but a research project in itself; calibration by
  two clicks plus "Copy scale to site" covers most cases.
- **Cloud sync.** Would break the "nothing leaves your device" guarantee.
