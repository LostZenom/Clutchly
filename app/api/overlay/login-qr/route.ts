import { NextResponse } from "next/server";
import { startQrLogin } from "@/src/worker/qrLogin";

export const dynamic = "force-dynamic";

/**
 * POST /api/overlay/login-qr
 * Starts a Steam QR login challenge and renders it to a PNG data-URL.
 * Returns { id, qrDataUrl } — poll GET /api/overlay/login-qr/status?id=….
 */
export async function POST() {
  try {
    const { id, qrDataUrl } = await startQrLogin();
    return NextResponse.json({ ok: true, id, qrDataUrl });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: err instanceof Error ? err.message : "Could not start QR login." },
      { status: 500 },
    );
  }
}