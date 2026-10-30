# kitshn ads

Promo videos for kitshn, built like `mathbooklm-ad`: Remotion for the picture, and the `mv/` pipeline (ElevenLabs voice, music and sound effects) for the audio. Audio comes first, and every cue in the picture hangs off a spoken word, so a new reading retimes the cut.

## Explainer (60.5 s, 16:9)

"What kitshn does" in one minute: the hook, the promise, deploys and previews, the map (cards, circles, a real drag with its preview, Undo), Cloudflare Access, machines and the tunnel, the offline page, and the end card.

- Script and sound: `public/mv/explainer/spec.json`. The voice says "kitchen" for kitshn, and the captions spell it kitshn.
- Picture: `src/explainer/Explainer.tsx`. Where things sit on the plates: `src/explainer/config.ts` (`BOX`).
- Plates: real captures of the demo map in `public/shots/`, from `packages/edge/scripts/captures/ad.ts`. Nothing in the product UI is drawn by hand.

```bash
npm install
# 1. Plates (dark): a dev server on fresh state, then the capture.
#    In packages/edge, with DEV_IDENTITY=owner@example.com and DEV_DEMO=1 in .dev.vars:
#    KITSHN_DEV_STATE=<empty dir> npx --no vite dev --port 5181 --strictPort
node --experimental-strip-types scripts/capture-plates.ts http://localhost:5181 dark
# 2. Audio: voice, music, sfx, timeline and mix (cached; only changed items cost credits).
#    Needs ELEVENLABS_API_KEY in .env.local here, or in the environment.
<python with mv/requirements.txt> mv/mv.py build explainer
# 3. Look, then render.
node scripts/stills.mjs Explainer-16x9 3,17,35.6,52.5,59
node node_modules/@remotion/cli/remotion-cli.js render Explainer-16x9 out/explainer/kitshn-explainer-16x9.mp4
```

`pnpm capture` cannot start its own dev server on Windows, which is why `scripts/capture-plates.ts` runs the same scenario against a server you started.
