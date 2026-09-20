# Verifying a field

This is the process for resolving a `[CHANGE]`, `[WRONG PAGE]`,
`[MANUAL CHECK DUE]`, or `[VERIFY]` issue — anything that asks a human to
confirm a real-world value before it goes into the registry.

## Before you start: do this from India, on a normal connection

**Never use a VPN, and never verify from outside India.** Official visa
sites serve different content by applicant country — VFS Global URLs look
like `/{applicant}/{lang}/{destination}/`, and a VPN exit node or a
non-Indian IP can silently serve you the wrong country's fees, centres, or
processing times on the exact same URL. If you're not physically in India
on your normal ISP connection when you verify a value, the value you read
is not trustworthy, no matter how confident the page looks.

## Step by step

1. **Open the source.** Use the URL in the issue (or `source_url` /
   `collected_amount_source_url` on the fee itself, or the matching entry
   in `data/sources.yaml`).
2. **Read the value yourself.** Don't trust the issue's snippet or diff as
   the final word — they're there to tell you *something* changed, not to
   save you the trip to the actual page.
3. **Update the destination file** (`data/destinations/<iso_code>.yaml`) —
   or the ruleset file if it's a genuinely shared value:
   - Fill in the actual field (`amount`, `collected_amount`, a timing
     field, a requirement, whatever the issue is about).
   - Set `verified_on` to today. If you also confirmed the INR figure for
     an `official_inr` fee, set `collected_amount_verified_on` too — these
     are two independent clocks; don't assume one covers the other.
   - Set `verified_by` to your name.
4. **Add a `change_log` entry** under `meta.change_log`:
   ```yaml
   - date: 2026-09-20
     field: fees[consular_fee_adult].collected_amount
     old: 8300
     new: 8500
     by: your-name
     note: "VFS France fee page, checked from Delhi"
   ```
   This list is capped at the 20 most recent entries — Git history holds
   the rest, so don't worry about it growing forever.
5. **If you were resolving a source-check issue**, also update that
   source's entry in `data/sources.yaml`: `last_checked` (today),
   `last_changed` (today, only if the value actually changed),
   `last_seen_snippet` (a short excerpt of what you saw).
6. **Run the checks locally before opening a PR:**
   ```
   npm run validate
   npm test
   ```
7. **Open a PR** with your change. There's no branch-protection gate
   forcing this today (single-contributor repo, pushes straight to
   `main` are fine) — but routing anything you're not 100% sure about
   through a PR first, even to yourself, is still a reasonable way to
   catch a typo before it's live.

## Reverting a bad verification

If a verified value turns out to be wrong (misread the page, fat-fingered
a digit, verified the wrong country's page entirely):

1. Fix the field back to the correct value (or `null` if you genuinely
   don't know the right one anymore — **null is always safer than a
   guess**, and a null with no `verified_on` is not an error, just
   "not yet known" again).
2. Add a *new* `change_log` entry documenting the revert — don't delete
   the bad entry, since that erases the record of the mistake:
   ```yaml
   - date: 2026-09-21
     field: fees[consular_fee_adult].collected_amount
     old: 8500
     new: 8300
     by: your-name
     note: "Revert 2026-09-20 entry -- misread the page, correct figure is 8300"
   ```
3. If the value had already gone out in `docs/export/` (i.e. already
   merged and exported), the next `export-on-merge` run will pick up the
   correction automatically — no separate action needed there.
4. If you're not sure a value is right anymore and can't re-verify it
   immediately, set it (and its `verified_on`) back to `null` rather than
   leaving a value you no longer trust sitting there with an old
   verification date attached. A null is honest; a stale-but-still-set
   value is not.
