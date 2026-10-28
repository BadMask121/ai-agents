# 05 — Voice & Deepgram

Record in the browser, transcribe on the server. The Deepgram key never reaches the
client.

```
mic → getUserMedia → MediaRecorder → Blob
                                      │ POST /api/voice/transcribe
                                      │ Content-Type: recorder.mimeType
                                      ▼
                          express.raw() → Deepgram prerecorded API
                                      │
                                      ▼
                              { transcript }
                                      │
                        editable input → /api/ai/parse
```

## Why batch, not streaming

Record → stop → upload → transcribe, rather than a live WebSocket with interim words.

A quick-add utterance is 3–5 seconds. Batch costs one HTTP route and adds roughly a
second. Live streaming needs either a WebSocket proxy through our server or short-lived
Deepgram tokens (`POST /v1/auth/grant`, ~30s TTL) so the browser can connect directly,
plus interim-result reconciliation on the client. That's a lot of machinery for a second.

The mitigation is UI, not architecture — see the state machine below. If live words turn
out to matter, the change is contained to `voice.js` plus one route.

---

## Client — `public/js/voice.js`

```js
const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(stream);
const chunks   = [];

recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
recorder.onstop = async () => {
  const blob = new Blob(chunks, { type: recorder.mimeType });
  stream.getTracks().forEach((t) => t.stop());          // release the mic
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'content-type': recorder.mimeType },     // ← not hardcoded
    body: blob,
  });
  // → { transcript }
};
recorder.start();
```

### Send `recorder.mimeType`, don't hardcode it

Chrome and Firefox produce `audio/webm;codecs=opus`. **Safari produces `audio/mp4`.**
Deepgram handles both — but only if it's told which one it got. Hardcoding `audio/webm`
works right up until someone opens the app on an iPhone, and then fails with a container
error that reads like a Deepgram problem.

`MediaRecorder.isTypeSupported()` can be used to *prefer* opus where available, but the
`Content-Type` must always come from the recorder instance, never from a constant.

### Release the microphone

`stream.getTracks().forEach(t => t.stop())` on stop, and again on teardown. Skipping it
leaves the browser's mic-in-use indicator lit until the tab closes — which reads, fairly,
as the app still listening.

### State machine

Because there are no live words, the indicator is what stops it feeling frozen:

| State | UI |
|---|---|
| `idle` | Mic button, neutral |
| `recording` | Pulsing red + **elapsed seconds** + stop affordance |
| `transcribing` | Spinner, "transcribing…" |
| `parsing` | Spinner, "understanding…" |
| `error` | Inline message + retry, mic returns to idle |

Elapsed seconds matter more than they look — they're the only feedback that the recorder
is actually capturing, and they let the user judge when to stop.

### Auto-stop

Two guards, both needed:

- **Silence timeout** — stop after ~2s of quiet, so the user doesn't have to tap twice.
- **Hard cap** — stop unconditionally at 60s. A stuck recorder otherwise uploads
  megabytes and bills real money.

### Permission and device errors

`getUserMedia` rejects with a named error; distinguish them, because the fixes differ:

| Error | Meaning | Copy |
|---|---|---|
| `NotAllowedError` | Permission denied or dismissed | "Microphone access was blocked — enable it in your browser's site settings." |
| `NotFoundError` | No input device | "No microphone found." |
| `NotReadableError` | Device held by another app | "Your microphone is in use by another app." |

A generic "microphone error" for all three sends people to the wrong place.

### Secure context

`getUserMedia` is **unavailable outside a secure context**. It works on
`http://localhost`, and *not* over plain HTTP to an IP or domain. A plain-HTTP deploy
ships with the mic silently broken — `navigator.mediaDevices` is simply `undefined`.

Feature-detect and say so explicitly rather than letting it fail as a null dereference:

```js
if (!navigator.mediaDevices?.getUserMedia) {
  // disable the mic, explain that voice needs HTTPS
}
```

See [07-deployment](07-deployment.md).

---

## Server — `src/deepgram.ts`

```ts
import { createClient } from "@deepgram/sdk";

const deepgram = createClient(config.deepgramApiKey);

export async function transcribe(buffer: Buffer, mimeType: string): Promise<string> {
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(buffer, {
    model: "nova-3",
    smart_format: true,
    punctuate: true,
    mimetype: mimeType,
  });
  if (error) throw error;
  return result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}
```

> **Verify two things against Deepgram's current docs at implementation time:**
> the **model name** (their line has moved nova-2 → nova-3; a stale name is a *runtime*
> error, not a compile one) and the **v3 SDK response shape** above. Both are written from
> the v3 SDK as of this spec and neither is compiler-checked.

`smart_format` is what turns "one pm" into "1 PM" and adds punctuation — it materially
improves what Claude then has to parse, so leave it on.

### The route

```ts
app.post(
  "/api/voice/transcribe",
  requireAuth,
  express.raw({ type: ["audio/*"], limit: "10mb" }),
  handler,
);
```

- `express.raw`, **not** `express.json`. A JSON body parser on an audio route produces a
  confusing empty body rather than an error.
- `type: ["audio/*"]` so anything else falls through to a `415`.
- `limit: "10mb"` → `413` with a clear message. 10MB is minutes of opus; a legitimate
  quick-add is kilobytes.

### Returns the transcript and stops

The route does **not** chain into `/api/ai/parse`. Keeping them separate means:

- the user can fix a misheard word *before* the parse runs — the single highest-value
  correction point in the app;
- each route is independently testable (transcription with a fixture, parsing with text);
- a Deepgram failure and a Claude failure are distinguishable in the UI.

---

## Cost and abuse

Deepgram bills per minute of audio. For this app that's negligible — a few seconds per
todo. But `/api/voice/transcribe` is the one route where a caller can spend real money, so
**`requireAuth` and the size limit are load-bearing, not decoration.** An unauthenticated
transcribe endpoint on a public host is a metered API someone else gets to use.

The 60s client-side cap is a UX guard; the 10MB server-side limit is the actual control,
because the client can be bypassed.

---

## Testing

Transcription is testable without a browser, which makes it the part to verify first:

```bash
curl -sX POST localhost:8080/api/voice/transcribe \
  -H 'content-type: audio/webm' \
  --data-binary @sample.webm | jq
```

Record `sample.webm` once from the browser console and keep it as a fixture. Also confirm:

- an oversized body returns `413` rather than hanging,
- a `content-type: application/json` body returns `415`,
- an empty/silent clip returns `{ transcript: "" }` and the client handles it as
  "didn't catch that" rather than parsing an empty string.

The record path itself needs a real browser. Do that leg in **Chrome and Safari** — Safari
is the one that emits `audio/mp4`, and it's the entire reason the `Content-Type`
passthrough exists.
