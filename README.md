# HybridShield

Use cloud AI on customer messages without sending customer data to the cloud.

Support agents, clinic staff and HR teams paste names, phone numbers, emails and card details into AI chatbots to get help writing replies. HybridShield hides those details **on the user's own computer** with Gemini Nano, sends only placeholder text to the cloud model, then puts the real details back into the answer locally.

Built for **#BuildHybridAI 2026** with **Firebase AI Logic hybrid inference** (Web / Chrome).

## How it works

| Step | Where | What happens |
|---|---|---|
| 1. Detect | On-device | Pattern rules (email, phone, card, Aadhaar, PAN, IFSC) + **Gemini Nano** with `InferenceMode.ONLY_ON_DEVICE` and structured output finds names, addresses, health details |
| 2. Redact | On-device | Each detail becomes a placeholder like `[PERSON_1]`; the mapping stays in browser memory only |
| 3. Route | On-device | Light task on short text → `PREFER_ON_DEVICE`. Heavy task or long text → `PREFER_IN_CLOUD` |
| 4. Generate | Device or cloud | The model only ever sees redacted text, so a cloud fallback is always safe |
| 5. Restore | On-device | Placeholders are swapped back for the real details |

The UI shows where each step ran, using `response.inferenceSource`.

Firebase AI Logic is used in [src/firebase.ts](src/firebase.ts), [src/redact.ts](src/redact.ts) and [src/pipeline.ts](src/pipeline.ts).

## Firebase products
- **AI Logic**: hybrid on-device (Gemini Nano) and cloud (Gemini) inference
- **App Check**: reCAPTCHA Enterprise in production, debug token for local development
- **Hosting**: public demo URL

## Run locally

Requirements: Node 20+, desktop Chrome 139+.

1. Enable on-device AI in Chrome: open `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, set **Enabled**, relaunch.
2. Install and start:
   ```bash
   npm install
   npm run dev
   ```
3. Open http://localhost:5173 and click **Protect and run** once.
4. The first time, the browser console (F12) prints an **App Check debug token**. Add it in Firebase console → App Check → Apps → Manage debug tokens, then run again.

Without Gemini Nano, the app still works: detection falls back to pattern rules and generation uses the cloud.

## Deploy
```bash
npm install -g firebase-tools
firebase login
npm run deploy
```

## License
Apache 2.0. See [LICENSE](LICENSE).
