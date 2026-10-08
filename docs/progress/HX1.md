# HX1: OpenCode harness

2026-10-08T03:53:08Z Claimed simmer-kag.2 on main-pc, branch wt/HX1. Beads uses the shared simmer database.

Installed OpenCode is 1.18.32. PATH resolves to the mise binary. Installed help confirms run, --format json, --auto, and --agent.

The probe runs in /tmp/HX1-probe with empty stdin, a 120-second timeout, and OPENCODE_PERMISSION='{"*":"allow"}'. It must create one file and read it through the shell.

Sources: https://opencode.ai/docs/cli/ and https://opencode.ai/docs/permissions/. The CLI docs define OPENCODE_PERMISSION. Permission docs define the allow rule and external_directory behavior.
