# Developer experience log

Append an entry at the moment friction occurs. Use UTC timestamps and include the exact page or command, response/error, time lost, and workaround.

Format:

`YYYY-MM-DD HH:MM UTC | module | page URL + section | what we did | exact error/response | time lost | workaround`

2026-10-05 18:50 UTC | environment | local shell | checked project prerequisites | Node v20.20.2 found; project requires Node >=22.0.0; pnpm v10.33.4 and Foundry v1.5.0 available | 0 min | keep the requirement explicit and resolve before M1 CI
2026-10-05 18:50 UTC | repository | /Users/user | checked workspace before initialization | no existing `redeye` directory; parent home-level repository contains unrelated dirty files | 0 min | use an isolated nested repository

