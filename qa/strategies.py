"""Exercise the released strategy parser and listener, without making an ISP efficacy claim."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time

directory = Path(os.environ["RUNNER_TEMP"])
release = os.environ.get("QA_RELEASE", "2.0.31")
(directory / "list-all.txt").write_text("example.com\n")
(directory / "list-general.txt").write_text("example.com\n")
(directory / "list-discord.txt").write_text("discord.com\n")
(directory / "list-exclude.txt").write_text("localhost\n")
js = """
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const main = fs.readFileSync(process.env.QA_RELEASE === '2.0.23' ? path.join(process.env.RUNNER_TEMP, 'main-2.0.23.js') : 'src/main/main.js', 'utf8');
const code = main.match(/^function buildDarwinStrategies\\(listsDir\\) \\{[\\s\\S]*?^\\}/m)[0];
console.log(JSON.stringify(vm.runInNewContext(code + ';buildDarwinStrategies(dir)', {path, tpwsPort: 38485, dir:process.env.RUNNER_TEMP})));
"""
strategies = json.loads(subprocess.check_output(["node", "-e", js], text=True))
assert len(strategies) >= 40
failed = []
for s in strategies:
    args = s["args"]
    port = int(args[args.index("--port") + 1])
    proc = subprocess.Popen([str(directory / ("tpws-" + release)), "--bind-addr=127.0.0.1", *args], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for i in range(90):
            if proc.poll() is not None:
                raise RuntimeError(f"{s['name']}: {proc.stderr.read().decode()}")
            try:
                with socket.create_connection(("127.0.0.1", port), 0.2):
                    break
            except OSError:
                time.sleep(0.015)
        else:
            raise RuntimeError(f"{s['name']}: no listener")
    except RuntimeError as error:
        print(error, flush=True)
        failed.append(s["name"])
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=5)
print(f"release={release}: {len(strategies)-len(failed)}/{len(strategies)} macOS strategies opened the SOCKS port; failures={len(failed)}")
if release != "2.0.23":
    assert not failed
