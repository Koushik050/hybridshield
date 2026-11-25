import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";

// Firebase web config is public by design; access is protected by App Check.
const firebaseConfig = {
  apiKey: "AIzaSyAmB5lhTbriUjxALGwuO68jsuzxDR9AUQA",
  authDomain: "hybrid-ai-hackathon-af989.firebaseapp.com",
  projectId: "hybrid-ai-hackathon-af989",
  storageBucket: "hybrid-ai-hackathon-af989.firebasestorage.app",
  messagingSenderId: "877380083258",
  appId: "1:877380083258:web:2fa53fcaf5d8b41642df03",
};

export const app = initializeApp(firebaseConfig);

// ---- App Check (required by Firebase AI Logic) ----
const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;
if (debugToken) {
  (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken === "true" ? true : debugToken;
} else if (import.meta.env.DEV) {
  // On localhost: the SDK prints a debug token in the console to register once.
  (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(
    (import.meta.env.VITE_RECAPTCHA_SITE_KEY as string) || "debug-mode-placeholder",
  ),
  isTokenAutoRefreshEnabled: true,
});

// ---- Firebase AI Logic ----
const ai = getAI(app, { backend: new GoogleAIBackend() });

const textIO = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

export const detectionSchema = Schema.object({
  properties: {
    items: Schema.array({
      items: Schema.object({
        properties: {
          text: Schema.string(),
          type: Schema.string(),
        },
      }),
    }),
  },
});

/**
 * Finds personal details. ONLY_ON_DEVICE: this model sees the real text,
 * so it must never fall back to the cloud. If Gemini Nano is missing it throws,
 * and the app uses pattern rules only.
 */
export const detectorModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    createOptions: textIO as any,
    promptOptions: { responseConstraint: detectionSchema } as any,
  },
});

/** Light tasks: prefer on-device. Input is already redacted, so a cloud fallback is safe. */
export const lightWriter = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  onDeviceParams: { createOptions: textIO as any },
});

/** Heavy tasks: prefer the stronger cloud model; falls back to on-device when offline. */
export const heavyWriter = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_IN_CLOUD,
  onDeviceParams: { createOptions: textIO as any },
});

export type DeviceStatus = "available" | "downloadable" | "downloading" | "unavailable";

/** Asks Chrome's Prompt API whether Gemini Nano is ready on this computer. */
export async function getDeviceStatus(): Promise<DeviceStatus> {
  const LM = (globalThis as any).LanguageModel;
  if (!LM?.availability) return "unavailable";
  try {
    return (await LM.availability(textIO)) as DeviceStatus;
  } catch {
    return "unavailable";
  }
}

let initStarted = false;
/** Must run on a user click. Starts the Gemini Nano download if needed. */
export function startDeviceModel(onProgress: (pct: number) => void) {
  if (initStarted) return;
  initStarted = true;
  for (const m of [detectorModel, lightWriter]) {
    try {
      const p = (m as any).initializeDeviceModel?.((v: number) => onProgress(Math.round(v * 100)));
      // On computers without Gemini Nano this rejects; that's expected, the app falls back.
      if (p && typeof p.catch === "function") p.catch((e: unknown) => console.info("On-device model not available:", e));
    } catch (e) {
      console.warn("initializeDeviceModel failed", e);
    }
  }
}
