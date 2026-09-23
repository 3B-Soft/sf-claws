# Chrome Web Store assets

Generated, not hand-made. Regenerate rather than editing, so they cannot drift from the UI they
show:

```
bun run --filter @sf-claws/shared build
bun tools/render-icons.mjs          # only when src/icons/logo.svg changed
bun run --filter @sf-claws/extension build:store
bun run --filter @sf-claws/admin-ui build
bun tools/demo-server.mjs --port 8799 > /tmp/demo.json &
bun tools/screenshots.mjs --demo /tmp/demo.json --out docs/screenshots
bun tools/store-assets.mjs --shots docs/screenshots --out docs/store
```

`tools/store-assets.mjs` only frames the real screenshots from `tools/screenshots.mjs` and adds the
listing captions. It fails rather than drawing a product shot of its own if a source image is
missing: Chrome Web Store policy requires screenshots to represent actual functionality.

See `docs/PUBLISHING.md` for which file goes in which store field.
