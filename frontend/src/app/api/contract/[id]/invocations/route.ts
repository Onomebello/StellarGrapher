import { NextResponse } from "next/server";
import { getInvocationHistoryPage } from "@/lib/soroban";
import { parsePageRequest } from "@/lib/history-cursor";
import { INVOCATION_PAGE_SIZE } from "@/lib/contract-lists";
import { rateLimitRequest } from "@/lib/rate-limit";
import { xdr, scValToNative } from "@stellar/stellar-sdk";

export const dynamic = "force-dynamic";

interface Params { params: { id: string } }

interface DecodedArg {
  type: string;
  value: unknown;
  raw: string;
  decoded: boolean;
}

function decodeScVal(raw: string): DecodedArg {
  try {
    const scVal = xdr.ScVal.fromXDR(raw, "base64");
    const native = scValToNative(scVal);
    return {
      type: scVal.switch().name,
      value: normalizeNative(native),
      raw,
      decoded: true,
    };
  } catch {
    return { type: "unknown", value: raw, raw, decoded: false };
  }
}

function normalizeNative(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalizeNative);
  if (value && typeof value === "object") {
    if (value instanceof Map) {
      return Array.from(value.entries()).map(([k, v]) => [
        normalizeNative(k),
        normalizeNative(v),
      ]);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        normalizeNative(v),
      ]),
    );
  }
  return value;
}

function decodeArgs(args: unknown): DecodedArg[] {
  if (!Array.isArray(args)) return [];
  return args.map((arg) =>
    typeof arg === "string"
      ? decodeScVal(arg)
      : { type: "unknown", value: arg, raw: String(arg), decoded: false },
  );
}

export async function GET(req: Request, { params }: Params) {
  const limited = rateLimitRequest(req, { scope: "contract-invocations" });
  if (limited) return limited;

  const request = parsePageRequest(new URL(req.url), INVOCATION_PAGE_SIZE);
  if (!request) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });

  const { items, nextCursor } = await getInvocationHistoryPage(params.id, request);
  const invocations = items.map((item) => ({
    ...item,
    decodedArgs: decodeArgs((item as { args?: unknown }).args),
  }));
  return NextResponse.json({ invocations, nextCursor });
}
