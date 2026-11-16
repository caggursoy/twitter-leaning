# Political Compass

Static web app. Reads the latest public posts from an X account and places it on two political scales
using a Groq-hosted model.

- Data: FxTwitter read API. No key.
- Model: Groq, `openai/gpt-oss-20b` by default.
- Hosting: GitHub Pages. No backend, no build step.

The prompt is: *"read the tweets from this user, provide the political alignment of this user"*. The
model returns two numbers in −1…+1:

| Axis | −1 | +1 |
| --- | --- | --- |
| Economic | redistribution, state ownership, regulation | free markets, low taxes, privatisation |
| Social | libertarian, civil liberties, anti-surveillance | authoritarian, order, tradition, restrictions |

Both scales are drawn from those same two numbers, so they always agree:

- **Placement** — the four-quadrant compass.
- **Ideology map** — a 12×12 grid of named ideologies, from Communism at the top left to
  Anarcho-Capitalism at the bottom right.

## Deploy

```bash
git remote add origin git@github.com:<you>/twitter-leaning.git
git push -u origin main
```

Then **Settings → Pages → Source: GitHub Actions**. `.github/workflows/pages.yml` deploys on every push
to `main`, to `https://<you>.github.io/twitter-leaning/`.

## Use

1. Paste a Groq key from <https://console.groq.com/keys>. It stays in `localStorage` and goes only to
   `api.groq.com`.
2. Enter a handle without the `@`.
3. Pick 10–500 posts (default 100) and press **Analyse account**.

## Models

`llama-3.1-8b-instant` was retired on 16 Aug 2026. The default is `openai/gpt-oss-20b`.

**Load models for this key** rebuilds the dropdown from `GET /openai/v1/models`, so it stays correct
when Groq changes its catalog. Free-tier limits are 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD.

## Limits

- A 500-post timeline is ~20,000 tokens, more than the 8,000 TPM free tier allows in one request. The
  app splits it into ~5,000-token batches, scores each, then merges them. A 500-post run takes about
  three minutes; 100 posts is a single call.
- The placement is a heuristic reading of recent public text, not a measurement of anyone's beliefs.
  Reposts and quote-tweets count as signal.
- FxTwitter is third-party and can rate limit or change.
- Not affiliated with X, Groq or FxTwitter.

## Files

```
index.html                     markup and both chart SVGs
styles.css                     styling
app.js                         fetching, prompt, Groq call, rendering
.github/workflows/pages.yml    Pages deployment
```
