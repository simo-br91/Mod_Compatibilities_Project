This directory is the local Forge server template used by the ground-truth runner.

What it is for:
- The ground-truth pipeline copies this folder into a temporary workdir
- It drops the candidate mod jars into `mods/`
- It starts Forge with `run.bat nogui` on Windows or `run.sh nogui` on Linux
- It watches the server logs to determine whether the pack reached startup/world load

How to populate it:
- Run `powershell -ExecutionPolicy Bypass -File .\runtime\forge-1.20.1-server-template\bootstrap.ps1`

Expected result after bootstrap:
- `run.bat`
- `libraries/`
- `forge-1.20.1-47.4.20-*.jar`
- other standard Forge server files

Notes:
- This template targets Minecraft `1.20.1`
- It uses Forge `47.4.20`
- The ground-truth runner copies this folder before each test, so this directory should stay as a clean base template
