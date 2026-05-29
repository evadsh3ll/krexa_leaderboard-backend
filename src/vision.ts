import Groq from 'groq-sdk';
import { getConfig } from './config';

/**
 * Vision OCR via Groq's multimodal Llama-4-Scout.
 *
 * Built for the #KrexaBillChallenge: entrants post a screenshot of their bill,
 * and we need the text off that image to land on the leaderboard. A vision LLM
 * beats classic OCR here because bill/app screenshots use stylized fonts and we
 * want structured fields (amount, vendor, date), not just a blob of glyphs.
 *
 * The image is downloaded and inlined as a base64 data URL so we never depend on
 * Groq being able to reach pbs.twimg.com itself.
 */

let client: Groq | null = null;
function getClient(): Groq {
  if (!client) client = new Groq({ apiKey: getConfig().GROQ_API_KEY });
  return client;
}

export interface OcrResult {
  ok: boolean;
  /** Full verbatim text read off the image. */
  text: string;
  /** Whether the image actually looks like a bill / receipt / transaction. */
  is_bill: boolean;
  /**
   * Which AI product the bill is for, normalised. The #KrexaBillChallenge is
   * about AI-tool spend, so this is the headline field: e.g. "Claude", "Codex",
   * "ChatGPT", "OpenAI", "Cursor", "Anthropic". "" if it can't be determined.
   */
  platform: string;
  /** Numeric total if a bill, else "". */
  amount: string;
  currency: string;
  vendor: string;
  date: string;
  error?: string;
}

const EMPTY: OcrResult = { ok: false, text: '', is_bill: false, platform: '', amount: '', currency: '', vendor: '', date: '' };

const PROMPT = `You are a precise OCR engine. Your PRIMARY job is to transcribe text.

STEP 1 - Transcribe EVERY readable character in the image, exactly as written,
line by line. Include headings, labels, numbers, fine print, button text, and
small or partial words. Do not summarize, skip, or judge relevance. This applies
to ANY image (screenshot, app UI, receipt, poster, meme, chart) - if a human can
read it, transcribe it.

STEP 2 - Only after transcribing, classify the image and pull a few fields.

This is for the #KrexaBillChallenge, where people post their AI-tool bills, so
pay special attention to WHICH AI product/service the bill is for.

Return STRICT JSON with exactly these keys:
{
  "text": "the full verbatim transcription from STEP 1, lines joined with \\n. Use \\"\\" ONLY if the image truly contains no characters at all (a pure photo).",
  "is_bill": true/false,            // is this a bill, receipt, invoice, or payment/transaction/usage screenshot?
  "platform": "the AI product/service this bill is for, normalised to one of: Claude, Codex, ChatGPT, OpenAI, Anthropic, Cursor, Gemini, Copilot, Perplexity, or the exact product name if it is something else. Use \\"\\" if it is not an AI-tool bill or cannot be determined.",
  "amount": "the single most prominent total amount as digits only, e.g. 1299.50, or \\"\\" if none",
  "currency": "currency symbol or code if visible (e.g. $, USD, INR, ₹), else \\"\\"",
  "vendor": "merchant / company name on the bill if visible, else \\"\\"",
  "date": "the bill/transaction date as shown, else \\"\\""
}
Do not invent values, but never omit text that is actually present.
Return ONLY the JSON object, no prose.`;

/** Download an image and return a base64 data URL, or null on failure. */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://x.com/' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * OCR a single image URL. Returns ok:false (never throws) on download/model
 * failure so a campaign harvest of hundreds of posts can't be derailed by one
 * bad image.
 */
export async function ocrImage(url: string): Promise<OcrResult> {
  const dataUrl = await fetchAsDataUrl(url);
  if (!dataUrl) return { ...EMPTY, error: 'image download failed' };

  let raw = '';
  try {
    const res = await getClient().chat.completions.create({
      model: getConfig().OCR_MODEL,
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ] as unknown as Groq.Chat.Completions.ChatCompletionMessageParam[],
    });
    raw = res.choices[0]?.message?.content ?? '';
  } catch (e) {
    return { ...EMPTY, error: e instanceof Error ? e.message : String(e) };
  }

  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
    return {
      ok: true,
      text: String(j.text ?? '').trim(),
      is_bill: Boolean(j.is_bill),
      platform: String(j.platform ?? '').trim(),
      amount: String(j.amount ?? '').trim(),
      currency: String(j.currency ?? '').trim(),
      vendor: String(j.vendor ?? '').trim(),
      date: String(j.date ?? '').trim(),
    };
  } catch {
    // Model answered but not as JSON — keep the text rather than lose it.
    return { ...EMPTY, ok: true, text: raw.trim() };
  }
}
