# Submission video — target 85 seconds

Use the selected real repository for the local demo; Harbor is a test fixture. Review the exact city views, commit subjects and diff excerpts before recording or publishing them. Keep credentials, personal tabs, terminal history and account details out of frame. Publishing Strata source does not publish the local scan or cached Decisions results.

1. **0–12 seconds:** “Agents can build faster than we can read. Strata shows what they leave behind.” Play the city’s history. Files rise; violet shortcuts appear.
2. **12–22 seconds:** Select a district and focus the camera. Show a violet shortcut and its public gate. Explain the observed dependency in one sentence.
3. **22–47 seconds:** Open **Read the changes**, also available in the guided tour. “Decisions reads the actual code changes: what was a repair, what was a reversal, and what remains unclear.” Select a real classified change, show its confidence, then its code evidence. Use **Before / After** for adjacent snapshots, or **Earlier scan / Commit view** when the scan is sampled. In the latter case, say that the views span several commits; do not attribute the whole visual difference to the selected change.
4. **47–65 seconds:** Open **Film** and show labeled highlights from the completed export: growth, a boundary worth reviewing, and the generated ending. “Astra turns the measured history into a story you can share.” Use already-completed results and do not imply generation is instantaneous.
5. **65–75 seconds:** Show the real Strata-on-Strata boundary check or the gate recommendation. “From understanding a change to deciding where to act.” Keep model confidence separate from measured evidence.
6. **75–85 seconds:** Show the verified public repository and setup command. “Built with Codex. Checked with Strata.”

## Prepare the Decisions segment

- Select the same repository and config for the scan and local server. Use a Python interpreter that supports the repository's syntax; `PYTHON=python3.14` fixes the newer-syntax mismatch in the current demo environment.
- Scan with `--history-analysis` for rolling rework. To retain more visual detail, raise `--max-snapshot-records` deliberately; it trades a larger city JSON for more views. This does not change how many commits full-history metrics analyze.
- Open **Read the changes → Classify changes** before recording. This sends bounded commit subjects and source diffs to the OpenAI Decisions API. Labels are cached locally; reopening the panel makes no paid request.
- Pick the strongest actual repair or reversal. Do not relabel an uncertain result for the pitch. Expand its evidence once and confirm that navigation shows the intended views.
- If the API is unavailable, use a previously completed cache for the same scan. Do not present placeholders as model output. The history labels are useful interpretation, not a validation of the entropy index.

Record a backup of each working step. Label generated illustrations as interpretations of the shown city; do not claim an exact image backend without verification.

Before submission: verify the final video is at most 90 seconds, verify public links signed out, check setup on a fresh clone, and credit the pre-event design prototype and dependencies. The Decisions request/response contract is documented in the [official guide](https://developers.openai.com/api/docs/guides/decisions).
