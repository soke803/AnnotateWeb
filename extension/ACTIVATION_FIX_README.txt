Annotate Web Chrome: activation reliability patch v1.1.3
============================================================
Changes over Smooth + Arrow v1.1.2:
- On toolbar icon click, verifies actual toolbar DOM visibility instead of trusting only a boolean flag.
- Repairs stale/hidden toolbar or partially initialized state.
- Prevents overlapping activation/deactivation on rapid clicks.
- Verifies initialization and retries once if the toolbar does not appear.
- Cleans injected CSS on toggle and prevents repeated shape-style accumulation.
- Fixes freeform default-selection handler after the document has loaded.
- Action icon shows green ON badge when active; red ! if activation fails. The badge clears on full-page navigation.
- Preserves existing smoothing slider, arrow cursor, and page annotation storage.

Install: chrome://extensions -> Developer mode -> Load unpacked -> select the inner folder containing manifest.json.
Disable the older modified version to avoid duplicate toolbars. Refresh your web page after installing.
If an existing unpacked extension was installed from the same folder, replace those files, then press Reload on its card.
Local storage remains on the webpage origin; do not clear the website's data if you need existing annotations.

Known restrictions: Chrome protected pages, Web Store, some PDF viewers, and sites that prohibit extension injection.
Tests: Syntax validation and mocked Chrome icon-click activation/recovery tests; real Chrome manual test still required.
