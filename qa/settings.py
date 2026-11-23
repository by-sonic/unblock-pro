"""Interact with the actual packaged app on an isolated Mac via its renderer."""
import os
from pathlib import Path
import subprocess
import time
from urllib.error import URLError
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

directory = Path(os.environ["RUNNER_TEMP"])
binary = next((directory / "unpacked").glob("*/Contents/MacOS/UnblockPro"))
port = 39455
endpoint = f"http://127.0.0.1:{port}"

with sync_playwright() as client:
    for visit in (1, 2):
        process = subprocess.Popen([str(binary), "--remote-debugging-address=127.0.0.1",
                                    f"--remote-debugging-port={port}",
                                    "--user-data-dir=" + str(directory / "isolated-settings")])
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError("App exited before opening the renderer")
                try:
                    with urlopen(endpoint + "/json/version", timeout=1):
                        break
                except (OSError, URLError):
                    time.sleep(0.25)
            browser = client.chromium.connect_over_cdp(endpoint)
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event("page")
            field = page.locator("#proxyPort")
            expect(field).to_be_visible(timeout=20000)
            if visit == 1:
                page.locator("#logsToggle").click()
                page.locator("#logsCopy").click()
                expect(page.locator("#logsCopyLabel")).to_contain_text("Скопирован")
                clipboard = subprocess.check_output(["/usr/bin/pbpaste"]).decode()
                assert "UnblockPro" in clipboard and "macOS" in clipboard and "Стратегия:" in clipboard
                print("Copied app report through visible log controls into the macOS clipboard", flush=True)
                field.fill("38481")
                page.locator("#savePortBtn").click()
                expect(page.locator("#portMessage")).to_contain_text("Сохранено. Порт 38481")
                print("Packaged UI saved 38481 using its real renderer and main IPC", flush=True)
            else:
                expect(field).to_have_value("38481")
                print("Packaged UI reopened with 38481 in the port field", flush=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=4)
