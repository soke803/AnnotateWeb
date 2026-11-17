Annotate Web - Chrome Smooth Mouse (Local)

Installation:
1. Extract the ZIP to a permanent folder on your Mac.
2. Chrome -> chrome://extensions -> Developer mode: ON.
3. Load unpacked -> choose the folder containing manifest.json.
4. Disable the original Annotate Web to avoid two overlays running together.
5. Open a website, click the new extension icon, choose the pen.
6. In the expansion panel dropdown, adjust `선 보정 (Smoothing)`:
   0% = no smoothing, 55% = balanced default, 75-90% = stronger smoothing.
7. Reload pages that had the old extension already injected.

What changed:
- Bluetooth mouse coordinate smoothing with an adjustable 0-100% slider.
- Smooth quadratic Bezier rendering for newly drawn freehand/highlighter paths.
- Uses Chrome PointerEvent.getCoalescedEvents() where available.
- Incremental rendering for freehand lines; avoids redrawing the entire stroke per pointermove.
- Preserves the original Chrome background script; no Safari-specific patch.
- Existing saved strokes render with their original geometry; new smoothed ones
  persist the smooth flag along with their coordinates.

Notes:
- Chrome cannot reliably distinguish a Bluetooth mouse from a trackpad in PointerEvent.pointerType.
- Local unpacked extensions do not update automatically from the Chrome Web Store.
- Drawing history is stored on each site. Do not remove site data before backing it up.
- This build was statically validated, not end-to-end tested in a live Chrome GUI.
