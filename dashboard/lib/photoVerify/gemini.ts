import { GoogleGenAI } from "@google/genai";
import { ProviderJudgmentSchema, describeItems, recordCall, type ExpectedItem, type ProviderJudgment } from "./types";
import type { Generation } from "../langfuse";

// Gemini vision leg of the verification gate. Uses JSON response mode, then
// validates the payload with zod (same schema Claude is held to) so both
// providers produce an identical judgment shape for `combine.ts`.

const MODEL = "gemini-2.5-flash"; // vision-capable, cheap

function prompt(items: ExpectedItem[]): string {
  return [
    "You are verifying a florist's delivery-proof photo before releasing their final payment.",
    "The customer ordered:",
    describeItems(items),
    "",
    "Look at the attached photo and decide whether it genuinely shows THIS order — the right kind of flowers/arrangement and any add-ons (chocolate, wine, vase, card).",
    "Be conservative: if the photo is blurry, generic, clearly a stock/reused image, or only shows some of the items, reflect that in a LOW confidence and list what is missing.",
    "",
    "Respond with ONLY a JSON object of this exact shape:",
    '{"matched": boolean, "confidence": number (0..1), "itemsFound": string[], "itemsMissing": string[], "notes": string}',
  ].join("\n");
}

export async function verifyWithGemini(
  base64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  items: ExpectedItem[],
  calls: Generation[],
): Promise<ProviderJudgment> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey });
  const instructions = prompt(items);

  return recordCall(calls, { name: "gemini", model: MODEL, input: ["[the delivery photo]", instructions] }, async (note) => {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mediaType, data: base64 } },
            { text: instructions },
          ],
        },
      ],
      config: { responseMimeType: "application/json" },
    });

    const text = response.text;
    note(text ?? null, response.usageMetadata ?? null);
    if (!text) throw new Error("Gemini returned an empty response");
    return ProviderJudgmentSchema.parse(JSON.parse(text));
  });
}
