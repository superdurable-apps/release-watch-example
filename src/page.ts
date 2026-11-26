/** The status page: the schedule, the latest digest and its releases, and a Run now button. */
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release Watch</title>
<style>
  :root { --bg: #fbfaf7; --fg: #1d1d1b; --muted: #6b6a66; --line: #e4e1da; --accent: #1f5f4a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #a09e97; --line: #2c2b29; --accent: #6fbf9f; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); cursor: pointer; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 13px; color: var(--muted); font-weight: 600; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Release Watch</h1>
  <p class="muted" id="schedule">Loading…</p>
  <p><button id="run">Run a digest now</button> <span class="muted" id="note"></span></p>
  <h2 id="digest-title" style="font-size:18px;margin-top:28px"></h2>
  <p class="muted" id="digest-meta"></p>
  <table><thead><tr><th>#</th><th>Release</th><th>Library</th><th>Relevance</th><th>Status</th></tr></thead><tbody id="releases"></tbody></table>
</main>
<script>
const text = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function load() {
  const response = await fetch("/api/status");
  const { schedule, latest } = await response.json();
  document.getElementById("schedule").textContent = schedule
    ? "Runs " + (schedule.schedule.weekdaysOnly ? "weekdays" : "daily") + " at " + schedule.schedule.localTime + " " + schedule.schedule.timeZone + (schedule.nextDigestAt ? " · next " + new Date(schedule.nextDigestAt).toLocaleString() : "")
    : "The schedule has not started.";
  if (!latest || !latest.state) { return; }
  const state = latest.state;
  document.getElementById("digest-title").textContent = state.digestId;
  document.getElementById("digest-meta").textContent = state.status + " · " + state.candidateCount + " candidates · " + state.sourceErrors.length + " sources failed · " + state.skippedSources.length + " sources not connected";
  document.getElementById("releases").innerHTML = latest.releases.map((release) =>
    "<tr><td>" + release.number + "</td><td><a href=\\"" + text(release.url) + "\\">" + text(release.title) + "</a><div class=muted>" + text(release.summary) + "</div></td><td>" + text(release.library) + "</td><td>" + release.relevance + "</td><td>" + text(release.status) + (release.issueUrl ? " · <a href=\\"" + text(release.issueUrl) + "\\">issue</a>" : "") + "</td></tr>").join("");
}
document.getElementById("run").addEventListener("click", async () => {
  const response = await fetch("/api/digests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "page" }) });
  document.getElementById("note").textContent = response.ok ? "Queued. The digest posts to Slack when it is ready." : "Could not queue a digest.";
});
load().catch(() => { document.getElementById("schedule").textContent = "Could not read the status."; });
</script>
</body>
</html>
`;
