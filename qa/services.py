"""Record what the hosted runner can establish about real playback and login."""
import json
import os
from pathlib import Path
import subprocess
import time
from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

directory = Path(os.environ["RUNNER_TEMP"])
port = 38486
js = """
const path = require('path'), fs = require('fs'), vm = require('vm');
const dir = process.env.RUNNER_TEMP;
const main = fs.readFileSync('src/main/main.js', 'utf8');
const canned = require('./src/main/flowseal-lists');
const dc = vm.runInNewContext(main.match(/const HOST_LIST_DISCORD = [\\s\\S]*?;$/m)[0] + 'HOST_LIST_DISCORD');
fs.writeFileSync(path.join(dir, 'list-all.txt'), [canned.HOST_LIST_GENERAL, canned.HOST_LIST_GOOGLE, dc].join('\\n'));
fs.writeFileSync(path.join(dir, 'list-exclude.txt'), canned.HOST_LIST_EXCLUDE);
const code = main.match(/^function buildDarwinStrategies\\(listsDir\\) \\{[\\s\\S]*?^\\}/m)[0];
console.log(JSON.stringify(vm.runInNewContext(code + ';buildDarwinStrategies(dir)', {path, tpwsPort:38486, dir}).find(s => s.name === 'combined-v6').args));
"""
args = json.loads(subprocess.check_output(["node", "-e", js], text=True))
proc = subprocess.Popen([directory / ("tpws-" + os.environ["QA_RELEASE"]), "--bind-addr=127.0.0.1", *args], stdout=subprocess.DEVNULL)
try:
    subprocess.run(["node", "qa/service-checks.js"], check=True)
    opts = Options()
    opts.binary_location = os.environ["FIREFOX_BIN"]
    opts.add_argument("-headless")
    for key, value in {"network.proxy.type": 1, "network.proxy.socks": "127.0.0.1", "network.proxy.socks_port": port,
                       "network.proxy.socks_version": 5, "network.proxy.socks5_remote_dns": True,
                       "network.proxy.failover_direct": False, "media.autoplay.default": 0}.items():
        opts.set_preference(key, value)
    with webdriver.Firefox(options=opts, service=Service(str(directory / "geckodriver"))) as driver:
        driver.set_page_load_timeout(32)
        for label, url in [
            ("youtube", "https://www.youtube.com/watch?v=M7lc1UVf-VE"),
            ("discord", "https://discord.com/app")
        ]:
            try:
                driver.get(url)
            except WebDriverException as err:
                print(label, "navigation", err.msg.splitlines()[0][:240], flush=True)
            if label == "youtube":
                player = """
const p=document.querySelector('#movie_player'), v=p?.querySelector('video');
return {videoId:p?.getVideoData?.()?.video_id || '', time:v?.currentTime || 0, ready:v?.readyState,
ads:p?.classList.contains('ad-showing') || false,
error:document.querySelector('.ytp-error-content-wrap, ytd-player-error-message-renderer')?.innerText?.slice(0,200)};
"""
                driver.execute_script("const v=document.querySelector('video'); if (v) {v.muted=true; v.play().catch(()=>{});}")
                samples = []
                for _ in range(7):
                    state = driver.execute_script(player)
                    samples.append(state)
                    if state["error"]:
                        break
                    if state["videoId"] == "M7lc1UVf-VE" and not state["ads"] and state["time"] > 4:
                        break
                    time.sleep(3)
                print("YouTube Firefox player samples:", json.dumps(samples, ensure_ascii=False), flush=True)
            if label == "discord":
                hello = driver.execute_async_script("""
const done=arguments[arguments.length-1];
const ws=new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
let settled=false;
function finish(value) { if(settled) return; settled=true; ws.close(); done(value); }
ws.onmessage=e=>{ const msg=JSON.parse(e.data);
  finish({op:msg.op, heartbeat_interval:msg.d?.heartbeat_interval || null}); };
ws.onerror=()=>finish({error:'Connection failed'});
setTimeout(()=>finish({error:'No HELLO before timeout'}),8000);
""")
                print("Discord public WebSocket HELLO:", json.dumps(hello), flush=True)
            print(label, "page:", driver.title, "visible text:", driver.find_element("tag name", "body").text[:230], flush=True)
            assert proc.poll() is None
finally:
    proc.terminate()
    proc.wait(timeout=6)
