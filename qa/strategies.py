"""Exercise the released strategy parser and listener, without making an ISP efficacy claim."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time

directory = Path(os.environ["RUNNER_TEMP"])
(directory / "list-all.txt").write_text("example.com\n")
(directory / "list-general.txt").write_text("example.com\n")
(directory / "list-discord.txt").write_text("discord.com\n")
(directory / "list-exclude.txt").write_text("localhost\n")
js = """
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const main = fs.readFileSync('src/main/main.js','utf8');
const code = main.match(/^function buildDarwinStrategies\\(listsDir\\) \\{[\\s\\S]*?^\\}/m)[0];
console.log(JSON.stringify(vm.runInNewContext(code + ';buildDarwinStrategies(dir)', {path, tpwsPort: 38485, dir:process.env.RUNNER_TEMP})));
"""
strategies = json.loads(subprocess.check_output(["node", "-e", js], text=True))
assert len(strategies) >= 40
for s in strategies:
    proc = subprocess.Popen([str(directory / "tpws-2.0.31"), "--bind-addr=127.0.0.1", *s["args"]], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for i in range(90):
            if proc.poll() is not None:
                raise RuntimeError(f"{s['name']}: {proc.stderr.read().decode()}")
            try:
                with socket.create_connection(("127.0.0.1", 38485), 0.2):
                    break
            except OSError:
                time.sleep(0.015)
        else:
            raise RuntimeError(f"{s['name']}: no listener")
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=5)
print(f"ALL {len(strategies)} released macOS strategies opened the SOCKS port")
