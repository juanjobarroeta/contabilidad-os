import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseProductFromTopic, pickAudioFile, verifyZoomSignature, zoomEncryptToken } from "./zoom";

const SECRET = "shhh-zoom";

describe("verifyZoomSignature", () => {
  const body = JSON.stringify({ event: "recording.completed" });
  const ts = "1755600000";
  const good = `v0=${crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;

  it("acepta la firma correcta", () => {
    expect(verifyZoomSignature(body, ts, good, SECRET)).toBe(true);
  });

  it("rechaza firma alterada, timestamp distinto y headers ausentes", () => {
    expect(verifyZoomSignature(body, ts, good.slice(0, -1) + "0", SECRET)).toBe(false);
    expect(verifyZoomSignature(body, "1755600001", good, SECRET)).toBe(false);
    expect(verifyZoomSignature(body, null, good, SECRET)).toBe(false);
    expect(verifyZoomSignature(body, ts, null, SECRET)).toBe(false);
  });
});

describe("zoomEncryptToken", () => {
  it("es el HMAC-SHA256 hex del plainToken", () => {
    expect(zoomEncryptToken("abc", SECRET)).toBe(
      crypto.createHmac("sha256", SECRET).update("abc").digest("hex")
    );
  });
});

describe("pickAudioFile", () => {
  it("prefiere M4A sobre MP4", () => {
    const picked = pickAudioFile([
      { file_type: "MP4", download_url: "https://z/mp4" },
      { file_type: "M4A", download_url: "https://z/m4a" },
    ]);
    expect(picked?.download_url).toBe("https://z/m4a");
  });

  it("cae a MP4 si no hay audio-only, null si no hay nada usable", () => {
    expect(pickAudioFile([{ file_type: "MP4", download_url: "https://z/mp4" }])?.download_url).toBe("https://z/mp4");
    expect(pickAudioFile([{ file_type: "TRANSCRIPT", download_url: "https://z/t" }])).toBeNull();
    expect(pickAudioFile(undefined)).toBeNull();
  });
});

describe("parseProductFromTopic", () => {
  it("extrae el tag de la convención de nombres", () => {
    expect(parseProductFromTopic("[CONTABILIDADOS] Despacho Reyes — onboarding")).toBe("contabilidados");
    expect(parseProductFromTopic("  [Automotriz] Taller Vega")).toBe("automotriz");
  });

  it("sin convención devuelve null", () => {
    expect(parseProductFromTopic("Llamada con cliente")).toBeNull();
    expect(parseProductFromTopic(null)).toBeNull();
  });
});
