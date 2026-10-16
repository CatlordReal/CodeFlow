#!/usr/bin/env python3
"""Exercise the packaged Linux app through its real WebKitGTK WebDriver."""
import argparse
import base64
import ctypes
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


class XClientMessageData(ctypes.Union):
    _fields_ = [("b", ctypes.c_char * 20),
                ("s", ctypes.c_short * 10),
                ("l", ctypes.c_long * 5)]


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int),
                ("serial", ctypes.c_ulong),
                ("send_event", ctypes.c_int),
                ("display", ctypes.c_void_p),
                ("window", ctypes.c_ulong),
                ("message_type", ctypes.c_ulong),
                ("format", ctypes.c_int),
                ("data", XClientMessageData)]


class XEvent(ctypes.Union):
    _fields_ = [("xclient", XClientMessageEvent),
                ("pad", ctypes.c_long * 24)]


def send_wm_delete(window):
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                               ctypes.c_long, ctypes.POINTER(XEvent)]
    x11.XSendEvent.restype = ctypes.c_int
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Could not open X display")
    try:
        event = XEvent()
        event.xclient.type = 33  # ClientMessage
        event.xclient.display = display
        event.xclient.window = int(window)
        event.xclient.message_type = x11.XInternAtom(display, b"WM_PROTOCOLS", 0)
        event.xclient.format = 32
        event.xclient.data.l[0] = x11.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
        if not x11.XSendEvent(display, int(window), 0, 0, ctypes.byref(event)):
            raise RuntimeError("Could not send WM_DELETE_WINDOW")
        x11.XFlush(display)
    finally:
        x11.XCloseDisplay(display)


class Driver:
    def __init__(self):
        self.session = None

    def request(self, method, path, data=None):
        payload = None if data is None else json.dumps(data).encode()
        request = urllib.request.Request("http://127.0.0.1:4444" + path, payload,
                                         {"Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                value = json.load(response)["value"]
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
        if isinstance(value, dict) and "error" in value:
            raise RuntimeError(value)
        return value

    def start(self, executable):
        value = self.request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "tauri:options": {"application": str(executable)}}}})
        self.session = value["sessionId"]
        self.command("POST", "timeouts", {"script": 40000})

    def command(self, method, path, data=None):
        return self.request(method, "/session/" + self.session + "/" + path, data)

    def script(self, script, *args):
        return self.command("POST", "execute/sync", {"script": script, "args": list(args)})

    def invoke(self, name):
        result = self.command("POST", "execute/async", {"script": """
            const done = arguments[arguments.length - 1];
            window.__TAURI_INTERNALS__.invoke(arguments[0])
              .then(value => done({value})).catch(error => done({error: String(error)}));
        """, "args": [name]})
        if "error" in result:
            raise RuntimeError(result["error"])
        return result["value"]

    def wait(self, expression, label):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            value = self.script("return " + expression)
            if value:
                return value
            time.sleep(.15)
        raise RuntimeError("Timed out: " + label)

    def set_value(self, selector, value, kind="textarea"):
        if not self.script("""
            const input = document.querySelector(arguments[0]);
            if (!input) return false;
            const type = arguments[2] === 'input' ? HTMLInputElement : HTMLTextAreaElement;
            Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(input, arguments[1]);
            input.dispatchEvent(new Event('input', {bubbles:true}));
            input.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        """, selector, value, kind):
            raise RuntimeError("Missing control: " + selector)

    def select(self, selector, value):
        if not self.script("""
            const control = document.querySelector(arguments[0]);
            if (!control) return false;
            control.value = arguments[1];
            control.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        """, selector, value):
            raise RuntimeError("Missing select: " + selector)

    def capture(self, output, name):
        (output / name).write_bytes(base64.b64decode(self.command("GET", "screenshot")))

    def close(self):
        if self.session:
            self.request("DELETE", "/session/" + self.session)
            self.session = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    parser.add_argument("--output", type=Path, default=Path("output/linux-smoke"))
    parser.add_argument("--allow-bootstrap-updater", action="store_true",
                        help="Allow only the first Linux release's missing public updater target")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    executable = args.executable.resolve(strict=True)
    report = {"packagedApp": executable.name, "themes": {}, "recoveryRestored": False}
    driver = Driver()
    with tempfile.TemporaryDirectory(prefix="codeflow-linux-smoke-") as directory:
        environment = {**os.environ, "XDG_DATA_HOME": directory,
                       "APPIMAGE_EXTRACT_AND_RUN": "1"}
        with (args.output / "driver.log").open("w") as log:
            process = subprocess.Popen(["tauri-driver"], env=environment, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 20
                while True:
                    try:
                        driver.request("GET", "/status")
                        break
                    except (OSError, RuntimeError):
                        if process.poll() is not None or time.monotonic() > deadline:
                            raise RuntimeError("tauri-driver did not start")
                        time.sleep(.2)
                driver.start(executable)
                driver.command("POST", "window/rect", {"width": 1440, "height": 900})
                driver.wait("document.querySelectorAll('.flow-symbol').length > 2", "initial analysis")
                shell_layout = driver.script("""
                    const analyze = document.querySelector('.app-toolbar__actions > button[aria-label="Analyze again"]');
                    const update = document.querySelector('.app-toolbar__actions > button[aria-label="Check for updates"]');
                    const source = document.querySelector('.source-panel')?.getBoundingClientRect();
                    const chart = document.querySelector('.chart-panel')?.getBoundingClientRect();
                    return {
                      analyze: Boolean(analyze && !analyze.disabled && analyze.getClientRects().length),
                      update: Boolean(update && !update.disabled && update.getClientRects().length),
                      paneGap: source && chart ? Math.abs(source.right - chart.left) : null
                    };
                """)
                assert shell_layout["analyze"] and shell_layout["update"], shell_layout
                assert shell_layout["paneGap"] is not None and shell_layout["paneGap"] <= .5, shell_layout
                report["shell"] = shell_layout
                source = """#include <vector>
int total(const std::vector<int>& values) {
    int sum = 0;
    for (int value : values) {
        for (int repeat = 0; repeat < 3; ++repeat) { sum += helper(value); }
    }
    return sum;
}
int helper(int value) { return value * 2; }
"""
                driver.set_value('textarea[aria-label="C++ source code"]', source)
                driver.set_value('input[aria-label="C++ filename"]', "totals.cpp", "input")
                driver.wait("document.querySelectorAll('.flow-symbol--subprocess').length === 1", "loop overview")
                driver.select('select[aria-label="Loop expansion depth"]', "1")
                driver.wait("document.querySelectorAll('.flow-symbol--decision[data-loop]').length === 1", "expanded loop")
                for name, theme, mauve, green in [
                    ("Latte", "latte", "#8839ef", "#40a02b"),
                    ("Frappé", "frappe", "#ca9ee6", "#a6d189"),
                    ("Macchiato", "macchiato", "#c6a0f6", "#a6da95"),
                    ("Mocha", "mocha", "#cba6f7", "#a6e3a1"),
                ]:
                    clicked = driver.script("""
                        const menu = [...document.querySelectorAll('.app-toolbar__actions > details')]
                          .find(item => item.querySelector(':scope > summary')?.textContent.trim().startsWith('Appearance'));
                        if (!menu) return false;
                        if (!menu.open) menu.querySelector(':scope > summary')?.click();
                        const picker = menu.querySelector('.theme-picker');
                        if (!picker?.open) picker?.querySelector('summary')?.click();
                        const button = [...(picker?.querySelectorAll('.theme-picker__menu button') ?? [])]
                          .find(button => button.textContent.trim() === arguments[0]);
                        if (!menu.open || !picker?.open || !button || button.getClientRects().length === 0) return false;
                        button.click(); menu.open = false; return true;
                    """, name)
                    assert clicked, name + " missing"
                    driver.wait("document.documentElement.dataset.theme === " + json.dumps("catppuccin-" + theme), name)
                    colors = driver.script("""
                        const root = getComputedStyle(document.documentElement);
                        const shape = document.querySelector('.flow-symbol--decision[data-loop]');
                        const collapsed = document.querySelector('.flow-symbol--subprocess[data-loop]');
                        function values(node) {
                            const style = getComputedStyle(node.querySelector('.flow-symbol__outline'));
                            const badge = getComputedStyle(node.querySelector('.flow-symbol__loop-marker'));
                            return {fill: style.fill, stroke: style.stroke, badgeFill: badge.backgroundColor,
                                    badgeStroke: badge.borderTopColor};
                        }
                        return {decision: root.getPropertyValue('--diagram-decision-stroke').trim(),
                                subprocess: root.getPropertyValue('--diagram-subprocess-stroke').trim(),
                                expanded: values(shape), collapsed: values(collapsed)};
                    """)
                    assert colors["decision"] == mauve and colors["subprocess"] == green, colors
                    for shape in (colors["expanded"], colors["collapsed"]):
                        assert shape["fill"] == shape["badgeFill"] and shape["stroke"] == shape["badgeStroke"], shape
                    assert colors["expanded"]["stroke"] != colors["collapsed"]["stroke"], colors
                    report["themes"][name] = colors
                    driver.script("document.querySelector('button[aria-label=\"Fit View\"]')?.click()")
                    time.sleep(.5)
                    driver.capture(args.output, "linux-" + theme + "-wide.png")
                driver.command("POST", "window/rect", {"width": 900, "height": 900})
                time.sleep(.5)
                driver.capture(args.output, "linux-mocha-compact.png")
                driver.command("POST", "window/rect", {"width": 1440, "height": 900})
                driver.select('select[aria-label="Chart view"]', "program")
                driver.wait("""(() => {
                    const board = document.querySelector('.program-board');
                    const calls = [...(board?.querySelectorAll('.react-flow__edge-path') ?? [])]
                      .filter(path => { const dash = getComputedStyle(path).strokeDasharray; return dash && dash !== 'none' && dash !== '0px'; });
                    return document.querySelector('select[aria-label="Chart view"]')?.value === 'program' &&
                      board?.querySelectorAll('.program-group').length === 2 &&
                      board?.querySelector('.program-board__status')?.textContent?.trim().startsWith('2/2 ready') &&
                      board.querySelectorAll('.flow-symbol').length > 2 && calls.length >= 1;
                })()""", "C++ whole program")
                driver.script("document.querySelector('.program-board .react-flow__controls-fitview')?.click()")
                time.sleep(.5)
                driver.capture(args.output, "linux-program-cpp-wide.png")
                driver.command("POST", "window/rect", {"width": 900, "height": 900})
                driver.script("document.querySelector('.program-board .react-flow__controls-fitview')?.click()")
                time.sleep(.5)
                driver.capture(args.output, "linux-program-cpp-compact.png")
                report["wholeProgramCpp"] = {"groups": 2, "ready": 2, "callLinks": True}
                driver.select('select[aria-label="Chart view"]', "function")
                driver.wait("document.querySelectorAll('.flow-symbol--subprocess').length === 1", "C++ function view")
                driver.script("document.querySelector('.flow-symbol--subprocess').closest('.react-flow__node').dispatchEvent(new MouseEvent('click', {bubbles:true}))")
                driver.wait("Boolean(document.querySelector('textarea[aria-label=\"Box label\"]'))", "box editor")
                driver.set_value('textarea[aria-label="Box label"]', "Add values three times")
                driver.wait("document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent === 'Add values three times'", "edited label")
                deadline = time.monotonic() + 20
                while True:
                    recovery = driver.invoke("read_recovery")
                    if recovery and "Add values three times" in recovery["contents"]:
                        break
                    if time.monotonic() > deadline:
                        raise RuntimeError("Native recovery did not save edited label")
                    time.sleep(.2)
                project = json.loads(recovery["contents"])
                assert project["source"] == source and project["fileName"] == "totals.cpp"
                assert project["history"]["active"] and len(project["history"]["revisions"]) > 1
                clicked = driver.script("""
                    const button = document.querySelector('.app-toolbar__actions > button[aria-label="Check for updates"]');
                    if (!button || button.disabled || button.getClientRects().length === 0) return false;
                    button.click(); return true;
                """)
                assert clicked, "Check for updates control is unavailable"
                report["updater"] = driver.wait("(() => {const banner = document.querySelector('.update-banner'); if (!banner || banner.classList.contains('update-banner--checking')) return null; return {kind: banner.className, message: banner.querySelector('span')?.textContent?.trim()};})()", "native updater TLS request")
                bootstrap_error = ('Update check failed: None of the fallback platforms '
                                   '`["linux-x86_64-appimage", "linux-x86_64"]` were found '
                                   'in the response `platforms` object')
                if "error" in report["updater"]["kind"]:
                    assert args.allow_bootstrap_updater and report["updater"]["message"].strip() == bootstrap_error, report["updater"]
                    report["updaterBootstrap"] = True
                else:
                    report["updaterBootstrap"] = False
                # Send the same native WM_DELETE_WINDOW request as the titlebar X.
                def visible_windows(title):
                    result = subprocess.run(["xdotool", "search", "--onlyvisible", "--maxdepth", "1", "--name", title],
                                            capture_output=True, text=True)
                    return result.stdout.split()

                def wait_dialog():
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        windows = visible_windows("^Close CodeFlow$")
                        if windows:
                            return windows[0]
                        time.sleep(.1)
                    raise RuntimeError("Native close confirmation did not appear")

                main_window, = visible_windows("^CodeFlow$")
                send_wm_delete(main_window)
                dialog = wait_dialog()
                subprocess.run(["scrot", "--overwrite", str(args.output / "linux-close-dialog.png")], check=True)
                subprocess.run(["xdotool", "windowfocus", "--sync", dialog], check=True)
                subprocess.run(["xdotool", "key", "Escape"], check=True)
                deadline = time.monotonic() + 15
                while visible_windows("^Close CodeFlow$"):
                    if time.monotonic() > deadline:
                        raise RuntimeError("Cancel did not dismiss native close confirmation")
                    time.sleep(.1)
                assert main_window in visible_windows("^CodeFlow$"), "Cancel closed the app"
                driver.wait("Boolean(document.querySelector('.flow-symbol'))", "app remains open after Cancel")
                report["closeCanceled"] = True

                # Close immediately after editing, before the recovery debounce can run.
                driver.script("document.querySelector('.flow-symbol--subprocess').closest('.react-flow__node').dispatchEvent(new MouseEvent('click', {bubbles:true}))")
                driver.wait("Boolean(document.querySelector('textarea[aria-label=\"Box label\"]'))", "close recovery editor")
                driver.set_value('textarea[aria-label="Box label"]', "Close button recovery")
                driver.wait("document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent === 'Close button recovery'", "latest close edit")
                send_wm_delete(main_window)
                dialog = wait_dialog()
                subprocess.run(["xdotool", "windowfocus", "--sync", dialog], check=True)
                subprocess.run(["xdotool", "key", "Return"], check=True)
                deadline = time.monotonic() + 20
                while main_window in visible_windows("^CodeFlow$"):
                    if time.monotonic() > deadline:
                        raise RuntimeError("Confirmed native close did not close the app")
                    time.sleep(.1)
                try:
                    driver.close()
                except (OSError, RuntimeError):
                    driver.session = None
                driver.start(executable)
                driver.wait("document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent === 'Close button recovery'", "confirmed-close recovery")
                assert driver.script("return document.querySelector('textarea[aria-label=\"C++ source code\"]').value") == source
                report["closeConfirmed"] = True
                restored = json.loads(driver.invoke("read_recovery")["contents"])
                assert restored["fileName"] == "totals.cpp"
                assert restored["history"]["active"] and len(restored["history"]["revisions"]) >= len(project["history"]["revisions"])
                report["recoveryRestored"] = True
                report["closeRecoveryRestored"] = True

                csharp_source = """using System;
public class Demo {
    public static int Twice(int value) => value * 2;
    public static void Main() {
        foreach (int value in new[] { 1, 2, 3 }) {
            Console.WriteLine(Twice(value));
        }
    }
}
"""
                driver.select('select[aria-label="Source language"]', "csharp")
                driver.wait("Boolean(document.querySelector('textarea[aria-label=\"C# source code\"]'))", "C# editor")
                driver.set_value('textarea[aria-label="C# source code"]', csharp_source)
                driver.set_value('input[aria-label="C# filename"]', "Demo.cs", "input")
                driver.select('select[aria-label="Loop expansion depth"]', "1")
                driver.select('select[aria-label="Chart view"]', "program")
                driver.wait("""(() => {
                    const board = document.querySelector('.program-board');
                    const calls = [...(board?.querySelectorAll('.react-flow__edge-path') ?? [])]
                      .filter(path => { const dash = getComputedStyle(path).strokeDasharray; return dash && dash !== 'none' && dash !== '0px'; });
                    return document.querySelector('select[aria-label="Chart view"]')?.value === 'program' &&
                      board?.querySelectorAll('.program-group').length === 2 &&
                      board?.querySelector('.program-board__status')?.textContent?.trim().startsWith('2/2 ready') &&
                      board?.querySelector('.program-group[data-entry] header strong')?.textContent?.trim() === 'Main' &&
                      board.querySelectorAll('.flow-symbol').length > 2 && calls.length >= 1;
                })()""", "C# whole program")
                driver.command("POST", "window/rect", {"width": 1440, "height": 900})
                driver.script("document.querySelector('.program-board .react-flow__controls-fitview')?.click()")
                time.sleep(.5)
                driver.capture(args.output, "linux-program-csharp-wide.png")
                selected = driver.script("""
                    const symbol = [...document.querySelectorAll('.program-board .flow-symbol--process, .program-board .flow-symbol--io')]
                      .find(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
                    const node = symbol?.closest('.react-flow__node');
                    if (!node || node.querySelector('.program-group')) return false;
                    node.dispatchEvent(new MouseEvent('click', {bubbles:true}));
                    return true;
                """)
                assert selected, "C# program box was not clickable"
                driver.wait("Boolean(document.querySelector('textarea[aria-label=\"Box label\"]') && document.querySelector('.source-highlight'))", "C# program box editor and source highlight")
                time.sleep(.35)
                selection_context = driver.script("""
                    return {
                      highlight: document.querySelector('.source-highlight')?.getAttribute('style') ?? '',
                      transform: document.querySelector('.program-board .react-flow__viewport')?.style.transform ?? ''
                    };
                """)
                assert selection_context["highlight"] and selection_context["transform"], selection_context
                csharp_label = "Write doubled value"
                driver.set_value('textarea[aria-label="Box label"]', csharp_label)
                driver.wait("""(() => {
                    const labels = [...document.querySelectorAll('.program-board .flow-symbol__label')];
                    return labels.some(node => node.textContent === %s) &&
                      document.querySelector('select[aria-label="Chart view"]')?.value === 'program' &&
                      document.querySelector('.source-highlight')?.getAttribute('style') === %s &&
                      document.querySelector('.program-board .react-flow__viewport')?.style.transform === %s;
                })()""" % (json.dumps(csharp_label), json.dumps(selection_context["highlight"]), json.dumps(selection_context["transform"])), "stable C# program edit context")
                deadline = time.monotonic() + 20
                while True:
                    csharp_recovery = driver.invoke("read_recovery")
                    if csharp_recovery:
                        recovered_csharp = json.loads(csharp_recovery["contents"])
                        if (recovered_csharp.get("source") == csharp_source and
                                recovered_csharp.get("fileName") == "Demo.cs" and
                                recovered_csharp.get("language") == "csharp" and
                                recovered_csharp.get("view") == "program" and
                                csharp_label in json.dumps(recovered_csharp.get("edits", {})) and
                                recovered_csharp.get("history", {}).get("active") and
                                len(recovered_csharp.get("history", {}).get("revisions", [])) > 1):
                            break
                    if time.monotonic() > deadline:
                        raise RuntimeError("Native recovery did not save C# whole-program state")
                    time.sleep(.2)
                driver.command("POST", "window/rect", {"width": 900, "height": 900})
                driver.script("document.querySelector('.program-board .react-flow__controls-fitview')?.click()")
                time.sleep(.5)
                driver.capture(args.output, "linux-program-csharp-compact.png")

                main_window, = visible_windows("^CodeFlow$")
                send_wm_delete(main_window)
                dialog = wait_dialog()
                subprocess.run(["xdotool", "windowfocus", "--sync", dialog], check=True)
                subprocess.run(["xdotool", "key", "Return"], check=True)
                deadline = time.monotonic() + 20
                while main_window in visible_windows("^CodeFlow$"):
                    if time.monotonic() > deadline:
                        raise RuntimeError("Confirmed C# native close did not close the app")
                    time.sleep(.1)
                try:
                    driver.close()
                except (OSError, RuntimeError):
                    driver.session = None
                driver.start(executable)
                driver.wait("""document.querySelector('textarea[aria-label="C# source code"]')?.value === %s &&
                    document.querySelector('select[aria-label="Chart view"]')?.value === 'program' &&
                    [...document.querySelectorAll('.program-board .flow-symbol__label')].some(node => node.textContent === %s)""" % (json.dumps(csharp_source), json.dumps(csharp_label)), "confirmed-close C# recovery")
                final_csharp = json.loads(driver.invoke("read_recovery")["contents"])
                assert final_csharp["language"] == "csharp" and final_csharp["view"] == "program"
                assert final_csharp["source"] == csharp_source and csharp_label in json.dumps(final_csharp["edits"])
                assert final_csharp["history"]["active"] and len(final_csharp["history"]["revisions"]) >= len(recovered_csharp["history"]["revisions"])
                report["csharp"] = {"groups": 2, "ready": 2, "callLinks": True, "entry": "Main",
                                    "label": csharp_label, "recoveryRestored": True}
                (args.output / "linux-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
                print("PASS: packaged Linux runtime, C++ and C# whole-program boards, native recovery restarts, updater request")
            finally:
                try:
                    driver.close()
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)


if __name__ == "__main__":
    main()
