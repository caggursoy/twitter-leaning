# Political Compass

A static web app that reads the most recent public posts from an X/Twitter account and places that
account on a classic four-quadrant political compass.

- **Data**: [FxTwitter](https://docs.fxembed.com/) read API — public, CORS-enabled, no key required.
- **Model**: Groq chat completions, `llama-3.1-8b-instant` by default (free tier).
- **Hosting**: GitHub Pages. No backend, no build step, no server-side secrets.

The model is asked, verbatim: *"read the tweets from this user, provide the political alignment of this user"*,
and returns two axes in the range −1…+1:

| Axis | −1 | +1 |
| --- | --- | --- |
| Economic | redistribution, state ownership, regulation | free markets, low taxes, privatisation |
| Social | libertarian, civil liberties, anti-surveillance | authoritarian, order, tradition, restrictions |

Those two numbers place the marker in one of four quadrants: Authoritarian Left, Authoritarian Right,
Libertarian Left, Libertarian Right.

## Run locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` directly with `file://` also works in most
browsers, but a local server is closer to the deployed behaviour.

## Deploy to GitHub Pages

1. Create an empty repository on GitHub, then push this folder to it:

   ```bash
   git remote add origin git@github.com:<you>/twitter-leaning.git
   git push -u origin main
   ```

2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` deploys on every push to `main`.
   The site lands at `https://<you>.github.io/twitter-leaning/`.

## Using it

1. Paste a Groq API key from <https://console.groq.com/keys>. It is stored in `localStorage` on your
   device only when "Remember key on this device" is ticked, and is sent to `api.groq.com` and nowhere else.
2. Enter an account handle, without the `@`.
3. Pick how many posts to read (default 100, up to 500) and press **Analyse account**.

## How the data is fetched

1. The handle is resolved to a numeric user id through `GET /2/profile/{handle}`. That endpoint
   intermittently answers 404, so the app falls back to the account's RSS feed
   (`https://fxtwitter.com/{handle}/feed.xml`), takes an original post by the account, and reads the
   author id from `GET /2/status/{id}`.
2. Posts are paged in through `GET /2/profile/id:{id}/statuses?count=100&cursor=…` until the requested
   number is reached, deduplicated by post id, and sorted newest first.
3. Posts are trimmed to a ~16,000 character prompt budget (Groq's free tier is token-per-minute limited),
   so a very large request may analyse slightly fewer posts than requested. The UI reports the real count.

## Limits worth knowing

- The placement is a heuristic reading of recent public text, not a measurement of anyone's beliefs.
  Retweets and quote-tweets are included and counted as signal.
- FxTwitter is a third-party read API. It can rate limit, and it can change.
- The free Groq tier is rate limited per minute and per day; a 100-post request is a single completion,
  so it usually fits, but repeated runs in a minute can hit 429.
- Nothing here is affiliated with X, Groq or FxTwitter.

## Files

```
index.html                     markup, including the compass SVG
styles.css                     all styling
app.js                         data fetching, prompt, Groq call, rendering
.github/workflows/pages.yml    GitHub Pages deployment
```
