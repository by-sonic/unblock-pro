"""Before/after browser reproduction on an isolated hosted Mac using system proxy settings."""
import os
from pathlib import Path
import re
import select
import socket
import socketserver
import subprocess
import threading
import time

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

directory = Path(os.environ["RUNNER_TEMP"])
hostname = "raw.githubusercontent.com"
url = "https://" + hostname + "/by-sonic/unblock-pro/28c43e98fe8ab49a759b1351755a548970d0a14d/README.md"
relay_port = 38481
runtime_port = 38482

def command(*args):
    return subprocess.check_output(args, text=True).strip()

class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection(("127.0.0.1", runtime_port), timeout=4) as target:
                prefix = b""
                while True:
                    ready, _, _ = select.select([self.request, target], [], [], 20)
                    if not ready:
                        return
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        if source is self.request:
                            if len(prefix) < 300:
                                prefix = (prefix + data)[:300]
                                if prefix.startswith(b"\x04\x01") and prefix[4:7] == b"\0\0\0" and prefix[7:8] != b"\0" and hostname.encode() + b"\0" in prefix:
                                    self.server.saw_hostname.set()
                            target.sendall(data)
                        else:
                            self.request.sendall(data)
        except OSError:
            pass

class Listener(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

def check_version(release, expected, relay):
    proc = subprocess.Popen([directory / ("tpws-" + release), "--socks", "--bind-addr=127.0.0.1", "--port=" + str(runtime_port)], stdout=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", runtime_port), timeout=0.3):
                    break
            except OSError:
                time.sleep(0.1)
        assert proc.poll() is None, "tpws failed"
        opts = Options()
        opts.binary_location = os.environ["FIREFOX_BIN"]
        opts.add_argument("-headless")
        for pref, value in {"network.proxy.type":5, "network.proxy.socks_remote_dns":True, "network.proxy.socks5_remote_dns":True, "network.proxy.failover_direct":False}.items():
            opts.set_preference(pref, value)
        relay.saw_hostname.clear()
        with webdriver.Firefox(options=opts, service=Service(str(directory / "geckodriver"))) as driver:
            driver.set_page_load_timeout(28)
            try:
                driver.get(url)
                body = driver.find_element("tag name","body").text
                success = "ROSEVPN-BANNER-END" in body and "# UnblockPro" in body
            except WebDriverException as err:
                print("Page load:", err.msg.splitlines()[0], flush=True)
                success = False
            print(f"release={release} firefox={driver.capabilities['browserVersion']} nondefault_port={relay_port} title={driver.title!r} SOCKS4a_host={hostname} observed={relay.saw_hostname.is_set()} repo_readme_loaded={success}", flush=True)
            assert relay.saw_hostname.is_set(), "Did not see Firefox request our repository host in a SOCKS4a CONNECT via the system proxy"
            assert success == expected, f"Browser result for {release} differed from expectation"
    finally:
        proc.terminate()
        proc.wait(timeout=5)

def settings(action, service):
    js = """
const {createMacNetworkSettings}=require('./src/main/mac-network-settings');
const m=createMacNetworkSettings(process.env.RUNNER_TEMP+'/issue81-system-settings.json');
const r = process.argv[1] === 'apply' ? m.setProxy([process.argv[2]], Number(process.argv[3])) : m.restore();
console.log(JSON.stringify(r));
if (process.argv[1] === 'apply' ? r.applied !== 1 : !r.ok) process.exit(1);
"""
    subprocess.run(["node", "-e", js, action, service, str(relay_port)], check=True)

device = re.search(r"interface:\s+(\S+)", command("/sbin/route","-n","get","default")).group(1)
entries = re.findall(r"^\(\d+\) (.+)\n\(Hardware Port: .+, Device: ([^)]+)\)", command("/usr/sbin/networksetup","-listnetworkserviceorder"), re.M)
name = next(service for service, dev in entries if dev == device)
before = command("/usr/sbin/networksetup", "-getsocksfirewallproxy", name)
print("Default interface and service:", device, name, flush=True)
with Listener(("127.0.0.1", relay_port), Relay) as listener:
    listener.saw_hostname = threading.Event()
    threading.Thread(target=listener.serve_forever, daemon=True).start()
    try:
        settings("apply", name)
        sc = command("/usr/sbin/scutil","--proxy")
        print(sc, flush=True)
        assert re.search(r"SOCKSEnable\s*:\s*1", sc) and str(relay_port) in sc
        check_version("2.0.26", False, listener)
        check_version("2.0.31", True, listener)
    finally:
        settings("restore", name)
        after = command("/usr/sbin/networksetup", "-getsocksfirewallproxy", name)
        assert ("Enabled: No" in before and "Enabled: No" in after) or before == after
        listener.shutdown()
