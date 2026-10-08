# HX4: Kimi harness

2026-10-08T03:54:31.299453+00:00 Claimed simmer-kag.5. Kimi 2.0.0 resolves to /home/yiin/.kimi-code/bin/kimi.

The first probe rejected `--auto -p` with exit 1: `error: Cannot combine --prompt with --auto.`

The official command reference states that prompt mode uses auto permission by default. The second probe uses `kimi -p <prompt> --output-format stream-json`.

Reference: https://moonshotai.github.io/kimi-code/en/reference/kimi-command.md
