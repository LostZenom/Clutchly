import { NextResponse } from "next/server";
import { pollQrLogin, cancelQrLogin } from "@/src/worker/qrLogin";

export const dynamic = "force-dynamic";

/**
 * GET /api/overlay/login-qr/status?id=…
 * Returns the QR login's progress: { status: "waiting" } until the user scans +
 * approves, then { status: "authenticated", steamId, accountName }.
 * DELETE /api/overlay/login-qr/status?id=… cancels an in-progress QR login.
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ ok: false, message: "Missing session id." }, { status: 400 });
  try {
    const result = await pollQrLogin(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: err instanceof Error ? err.message : "Could not check login status." },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (id) cancelQrLogin(id);
  return NextResponse.json({ ok: true });
}