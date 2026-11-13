import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  ADVISOR_FEEDBACK_TYPE,
  object,
  projectAdvice,
} from "../core/telemetry.ts";

export function createAdvisorFeedbackExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "advisor_feedback",
      label: "Advisor feedback",
      description: "Optionally list delivered advisor notes with their real IDs and current feedback, or rate a delivered note useful/harmful with a short reason grounded in the implementation. This is voluntary usefulness feedback, not acceptance or a claim of truth. Pending notes cannot be rated.",
      promptSnippet: "Optionally inspect delivered advisor notes and record useful/harmful feedback grounded in the implementation.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "rate"] },
          noteId: { type: "string", minLength: 1 },
          rating: { type: "string", enum: ["useful", "harmful"] },
          reason: { type: "string", maxLength: 500 },
        },
        required: ["action"],
        additionalProperties: false,
      },
      executionMode: "sequential",
      execute: async (_id, params, signal, _update, ctx) => {
        if (signal?.aborted) throw new Error("Advisor feedback cancelled");
        const args = object(params);
        const notes = projectAdvice(ctx.sessionManager.getBranch());
        if (args.action === "list") {
          const delivered = notes.filter((note) => note.status === "delivered");
          return {
            content: [{ type: "text", text: JSON.stringify({ notes: delivered }) }],
            details: { notes: delivered },
          };
        }
        if (args.action !== "rate")
          throw new Error("Advisor feedback action must be list or rate");
        if (typeof args.noteId !== "string" || !args.noteId.trim())
          throw new Error("Advisor feedback requires a noteId from list");
        if (args.rating !== "useful" && args.rating !== "harmful")
          throw new Error("Advisor feedback rating must be useful or harmful");
        if (
          args.reason !== undefined &&
          (typeof args.reason !== "string" || args.reason.length > 500)
        )
          throw new Error(
            "Advisor feedback reason must be a string of at most 500 characters",
          );
        const note = notes.find((note) => note.id === args.noteId);
        if (!note)
          throw new Error(
            `Unknown advisor note: ${args.noteId}; use list for delivered note IDs`,
          );
        if (note.status !== "delivered")
          throw new Error(
            `Advisor note ${args.noteId} is not delivered and cannot be rated`,
          );
        const feedback = {
          rating: args.rating,
          ...(typeof args.reason === "string" && args.reason.trim()
            ? { reason: args.reason.trim() }
            : {}),
          timestamp: new Date().toISOString(),
          source: "assistant" as const,
        };
        pi.appendEntry(ADVISOR_FEEDBACK_TYPE, { noteId: note.id, ...feedback });
        const details = { noteId: note.id, feedback };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      },
    });
  };
}
