import nextEnv from "@next/env";
import { Connection } from "@temporalio/client";
import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
nextEnv.loadEnvConfig(process.cwd());

if (process.argv.includes("--openai")) {
  try {
    const result = await generateText({
      model: openai(process.env.OPENAI_REVIEW_MODEL || "gpt-5.4-mini"),
      output: Output.object({ schema: z.object({ ready: z.boolean() }) }),
      prompt: "Return ready as true.",
      maxOutputTokens: 1000,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(30000),
      providerOptions: { openai: { reasoningEffort: "low", store: false } },
    });
    console.log(
      "OpenAI structured generation:",
      result.output.ready ? "verified" : "unexpected response",
    );
  } catch (error) {
    console.error(
      "OpenAI check failed:",
      error instanceof Error ? error.name : "UnknownError",
      typeof error === "object" && error && "statusCode" in error
        ? error.statusCode
        : "",
    );
    process.exitCode = 1;
  }
}
if (process.argv.includes("--temporal")) {
  let connection: Connection | undefined;
  try {
    const namespace = process.env.TEMPORAL_NAMESPACE;
    if (!namespace) throw new Error("Missing namespace");
    connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS,
      tls: process.env.TEMPORAL_TLS !== "false",
      apiKey: process.env.TEMPORAL_API_KEY,
      metadata: { "temporal-namespace": namespace },
    });
    await connection.workflowService.describeNamespace({ namespace });
    console.log("Temporal namespace connection: verified");
  } catch (error) {
    console.error(
      "Temporal check failed:",
      error instanceof Error ? error.name : "UnknownError",
      typeof error === "object" && error && "code" in error ? error.code : "",
    );
    process.exitCode = 1;
  } finally {
    await connection?.close();
  }
}
