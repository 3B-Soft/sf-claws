# Chrome Web Store assets

Generated, not hand-made. Regenerate rather than editing, so they cannot drift from the UI they
show:

```
npm run build -w @sf-claws/shared
npm run build:store -w @sf-claws/extension
npm run build -w @sf-claws/admin-ui
node tools/demo-server.mjs --port 8799 > /tmp/demo.json &
node tools/screenshots.mjs --demo /tmp/demo.json --out docs/screenshots
node tools/store-assets.mjs --shots docs/screenshots --out docs/store
```

`tools/store-assets.mjs` only frames the real screenshots from `tools/screenshots.mjs` and adds the
listing captions. It fails rather than drawing a product shot of its own if a source image is
missing: Chrome Web Store policy requires screenshots to represent actual functionality.

See `docs/PUBLISHING.md` for which file goes in which store field.
