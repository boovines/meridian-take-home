import { z } from "zod";
import { DomainError } from "../domain/errors";
import { uuid } from "../domain/validation";

export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const origin = request.headers.get("origin");
  // Next's internal request URL can use localhost behind a proxy even when the
  // browser uses 127.0.0.1 or a deployment host. The Host header is the public host.
  if (origin) {
    let sameHost = false;
    try {
      sameHost =
        new URL(origin).host ===
        (request.headers.get("host") || new URL(request.url).host);
    } catch {
      /* invalid Origin */
    }
    if (!sameHost)
      throw new DomainError(
        403,
        "ORIGIN_MISMATCH",
        "Cross-origin changes are not allowed.",
      );
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 100000)
    throw new DomainError(413, "TOO_LARGE", "This change is too large.");
  try {
    return schema.parse(JSON.parse(text));
  } catch (e) {
    if (e instanceof SyntaxError)
      throw new DomainError(
        400,
        "INVALID_JSON",
        "Request must contain valid JSON.",
      );
    throw e;
  }
}
export const parseId = (value: string) => uuid.parse(value);
export async function respond(fn: () => Promise<unknown>, status = 200) {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return Response.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: {
            code: "VALIDATION",
            message: "Please check the fields.",
            details: error.issues,
          },
        },
        { status: 422 },
      );
    const code =
      typeof error === "object" && error && "code" in error ? error.code : null;
    if (code === "23505")
      return Response.json(
        {
          error: {
            code: "DUPLICATE",
            message: "This connection or pairing already exists.",
          },
        },
        { status: 409 },
      );
    if (code === "23503" || code === "23514")
      return Response.json(
        {
          error: {
            code: "INVALID_RELATIONSHIP",
            message: "This change has an invalid relationship or value.",
          },
        },
        { status: 422 },
      );
    console.error(
      "Request failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      {
        error: {
          code: "INTERNAL",
          message:
            "Unable to complete this request. Your edits have not been discarded.",
        },
      },
      { status: 500 },
    );
  }
}
