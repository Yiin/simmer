# HX0: harness registry and smoke script

2026-10-08T03:42:04.792773+00:00 Claimed simmer-kag.1. Read lane rules and project instructions.

Registry wiring will preserve Claude, Codex, and Pi behavior. Smoke databases must stay local.

2026-10-08T03:45:32.471096+00:00 Committed registry wiring and the smoke command. Existing adapters and process code are unchanged.

Local Beads probe passed in embedded mode with loopback routing. Global issue-prefix overrode the scratch prefix on the first setup. Added issue-prefix: smoke to the local config. No worker ran in that failed setup.

The smoke command reads attempt JSON from the issue notes field. It runs this checkout with --worktree and --json. Claude session markers are cleared only for this run.
