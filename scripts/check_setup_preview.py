"""Render the blank setup UI for local visual QA; never reads/writes credentials."""
import argparse
import json
from pathlib import Path
import tkinter as tk
from unittest.mock import patch
from PIL import ImageGrab
import local_setup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    findings = []
    capture_errors = []

    def capture(window):
        window.update()
        window.lift()
        window.attributes("-topmost", True)
        window.update()

        def save():
            window.update_idletasks()
            x, y = window.winfo_rootx(), window.winfo_rooty()
            width, height = window.winfo_width(), window.winfo_height()

            def check(widget):
                for child in widget.winfo_children():
                    if child.winfo_ismapped() and (child.winfo_rooty() + child.winfo_height() > y + height or child.winfo_rootx() + child.winfo_width() > x + width):
                        findings.append(child.winfo_class())
                    check(child)
            check(window)
            try:
                ImageGrab.grab(bbox=(x, y, x + width, y + height)).save(args.output)
            except OSError:
                capture_errors.append("desktop-capture-unavailable")
            finally:
                window.destroy()  # Locked/remote desktops must not leave QA windows hanging.
        window.after(700, save)
        tk.Misc.mainloop(window)

    with patch.object(tk.Tk, "mainloop", capture):
        local_setup.show_window(local_setup.ROOT, preview=True)
    print(json.dumps({"clipped_widgets": findings, "capture_errors": capture_errors, "output": None if capture_errors else str(args.output)}, ensure_ascii=False))
    return 1 if findings or capture_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
