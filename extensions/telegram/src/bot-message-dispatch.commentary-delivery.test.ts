import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchReplyRuntime } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createRuntime,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  getGlobalHookRunner,
  type TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramDraftStream } from "./draft-stream.js";

const chatId = -100123;
const topicId = 88;
const commentary = ["Checking the deployment", "The deployment is healthy"] as const;

function isDurableCommentary(text: string): boolean {
  return commentary.some((entry) => text === entry || text === `💬 ${entry}`);
}

function createForumContext(inboundId: number, quote = false): TelegramMessageContext {
  const context = createContext();
  const message: TelegramMessageContext["msg"] = {
    date: 0,
    message_id: inboundId,
    message_thread_id: topicId,
    chat: { id: chatId, type: "supergroup" as const, title: "Fixture", is_forum: true },
  };
  return createContext({
    ...context,
    chatId,
    isGroup: true,
    msg: message,
    primaryCtx: { ...context.primaryCtx, message },
    replyThreadId: topicId,
    resolvedThreadId: topicId,
    threadSpec: { id: topicId, scope: "forum" },
    ctxPayload: {
      ...context.ctxPayload,
      SessionKey: `agent:default:telegram:group:${chatId}:topic:${topicId}`,
      Body: "Check the deployment and report progress",
      BodyForAgent: "Check the deployment and report progress",
      From: `telegram:${chatId}`,
      To: `telegram:${chatId}`,
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      MessageSid: String(inboundId),
      MessageThreadId: topicId,
      ...(quote
        ? {
            ReplyToId: "12345",
            ReplyToBody: "Original deployment request",
            ReplyToQuoteText: "deployment request",
            ReplyToIsQuote: true,
          }
        : {}),
    },
  });
}

// The source emits item events, not hand-built commentary payloads. Core dispatch,
// the Telegram adapter, the compositor, and the send/edit/delete transports stay
// real so a tool/block envelope mismatch cannot pass two disconnected tests.
describeTelegramDispatch("Telegram commentary source-to-transport delivery", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-telegram-commentary-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "reply mode off",
      inboundId: 456,
      replyToMode: "off",
      preview: true,
      quote: false,
      hook: false,
    },
    {
      name: "first reply",
      inboundId: 457,
      replyToMode: "first",
      preview: true,
      quote: false,
      hook: false,
    },
    {
      name: "native quote",
      inboundId: 458,
      replyToMode: "first",
      preview: false,
      quote: true,
      hook: false,
    },
    {
      name: "batched reply",
      inboundId: 460,
      replyToMode: "batched",
      preview: true,
      quote: false,
      hook: false,
    },
    {
      name: "modifying hook",
      inboundId: 459,
      replyToMode: "first",
      preview: false,
      quote: false,
      hook: true,
    },
  ] as const)(
    "retains completed commentary before the final with verbose off and $name",
    async ({ inboundId, replyToMode, preview, quote, hook }) => {
      const withProgressCard = replyToMode === "first" || replyToMode === "off";
      const actualDraft =
        await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
      const actualDelivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
        "./bot/delivery.replies.js",
      );
      deliverReplies.mockImplementation(actualDelivery.deliverReplies);
      let draft: TelegramDraftStream | undefined;
      createTelegramDraftStream.mockImplementation((params) => {
        const stream = actualDraft.createTelegramDraftStream(params);
        draft ??= stream;
        return stream;
      });
      if (hook) {
        getGlobalHookRunner.mockReturnValue({
          hasHooks: (hookName: string) => hookName === "message_sending",
          runMessageSending: vi.fn(async () => undefined),
        });
      }

      const bot = createBot();
      const runtime = createRuntime();
      const visible = new Map<number, string>();
      let nextMessageId = 1001;
      const send = vi
        .spyOn(bot.api, "sendMessage")
        .mockImplementation(async (_chat, text, options) => {
          const message_id = nextMessageId++;
          visible.set(message_id, text);
          return {
            message_id,
            date: 0,
            chat: { id: chatId, type: "supergroup", title: "Fixture" },
            message_thread_id: options?.message_thread_id,
            is_topic_message: true,
            text,
          };
        });
      const edit = vi
        .spyOn(bot.api, "editMessageText")
        .mockImplementation(async (_chat, messageId, text) => {
          if (typeof text !== "string") {
            throw new Error("Expected Telegram text edit");
          }
          visible.set(messageId, text);
          return true;
        });
      const remove = vi
        .spyOn(bot.api, "deleteMessage")
        .mockImplementation(async (_chat, messageId) => {
          visible.delete(messageId);
          return true;
        });
      const beforeFinal: Array<Map<number, string>> = [];
      const toolWork = commentary.map(() => createDeferred<void>());
      const toolStarted = commentary.map(() => createDeferred<void>());
      let reachedTools = 0;
      let resolverCompleted = false;
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation((params) =>
        dispatchReplyRuntime({
          ...params,
          replyResolver: async (_ctx, options) => {
            await options?.onReplyStart?.();
            await options?.onAssistantMessageStart?.();
            if (withProgressCard) {
              // Successful progress_card calls reach channels as plan updates.
              // Keep this plan active while commentary and tool activity arrive.
              await options?.onPlanUpdate?.({
                phase: "update",
                source: "openclaw",
                explanation: "Verifying the deployment",
                steps: [
                  { step: "Inspect deployment", status: "completed" },
                  { step: "Check service health", status: "in_progress" },
                  { step: "Report results", status: "pending" },
                ],
              });
            }
            for (const [index, text] of commentary.entries()) {
              const itemId = `commentary-${index}`;
              await options?.onItemEvent?.({
                kind: "preamble",
                itemId,
                phase: "update",
                progressText: text.slice(0, 12),
              });
              await options?.onItemEvent?.({
                kind: "preamble",
                itemId,
                phase: "update",
                progressText: text,
              });
              await options?.onItemEvent?.({
                kind: "preamble",
                itemId,
                phase: "end",
                progressText: text,
              });
              await options?.onToolStart?.({
                name: "exec",
                phase: "start",
                toolCallId: `tool-${index}`,
              });
              await draft?.flush();
              reachedTools = index + 1;
              toolStarted[index]?.resolve();
              // Keep the agent busy while the ordinary delivery queue drains.
              // The test observes Bot API settlement before allowing a final.
              await toolWork[index]?.promise;
            }
            resolverCompleted = true;
            // The real agent payload builder carries the originating reply
            // target; the Telegram adapter applies first/off and native quotes.
            return { text: "Final deployment report", replyToId: String(inboundId) };
          },
        }),
      );

      let dispatchFailure: unknown;
      const dispatchPromise = dispatchWithContext({
        bot,
        runtime,
        context: createForumContext(inboundId, quote),
        replyToMode,
        streamMode: "progress",
        cfg: {
          session: { store: path.join(stateDir, "sessions.json") },
          agents: { defaults: { verboseDefault: "off", humanDelay: { mode: "off" } } },
          messages: { groupChat: { visibleReplies: "automatic" } },
          channels: { telegram: { botToken: "test-token", replyToMode } },
        },
        telegramCfg: {
          streaming: {
            mode: "progress",
            progress: { toolProgress: true, commentary: withProgressCard, maxLines: 8 },
          },
        },
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      }).catch((error: unknown) => {
        dispatchFailure = error;
      });

      try {
        for (const [index, work] of toolWork.entries()) {
          await Promise.race([toolStarted[index]?.promise, dispatchPromise]);
          await vi.waitFor(() => {
            expect(reachedTools).toBe(index + 1);
            expect([...visible.values()].filter(isDurableCommentary)).toHaveLength(index + 1);
          });
          beforeFinal.push(new Map(visible));
          work.resolve();
        }
      } finally {
        for (const work of toolWork) {
          work.resolve();
        }
        await dispatchPromise;
      }

      // Keep assertions outside the resolver: a failing assertion must not become
      // a caught provider error followed by an apparently valid fallback final.
      expect(runtime.error).not.toHaveBeenCalled();
      expect(dispatchFailure).toBeUndefined();
      expect(resolverCompleted).toBe(true);
      expect(beforeFinal).toHaveLength(2);
      for (const [index, snapshot] of beforeFinal.entries()) {
        expect([...snapshot.values()].filter(isDurableCommentary)).toHaveLength(index + 1);
        expect([...snapshot.values()]).not.toContain("Final deployment report");
      }
      if (preview) {
        // Production cleanup deliberately waits for the four-second preview
        // dwell, detached from final delivery. Wait for that observable boundary.
        await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce(), { timeout: 5_000 });
      }
      const finalHistory = [...visible.values()];
      expect(finalHistory.filter(isDurableCommentary)).toHaveLength(2);
      expect(finalHistory).toContain("Final deployment report");
      expect(finalHistory).toHaveLength(3);

      const durableSends = send.mock.calls.filter(([, text]) => isDurableCommentary(text));
      expect(durableSends).toHaveLength(2);
      for (const [target, , options] of durableSends) {
        expect(String(target)).toBe(String(chatId));
        expect(options?.message_thread_id).toBe(topicId);
        expect(options?.reply_parameters).toBeUndefined();
        expect(options).not.toHaveProperty("reply_to_message_id");
      }
      const finalSend = send.mock.calls.find(([, text]) => text === "Final deployment report");
      expect(finalSend?.[2]?.message_thread_id).toBe(topicId);
      if (replyToMode === "off") {
        expect(finalSend?.[2]?.reply_parameters).toBeUndefined();
        expect(finalSend?.[2]).not.toHaveProperty("reply_to_message_id");
      } else if (quote) {
        expect(finalSend?.[2]?.reply_parameters?.message_id).toBe(12345);
        expect(finalSend?.[2]?.reply_parameters?.quote).toBe("deployment request");
      } else {
        expect(finalSend?.[2]).toMatchObject({ reply_to_message_id: inboundId });
      }

      if (preview) {
        expect(createTelegramDraftStream).toHaveBeenCalledOnce();
        for (const [index, snapshot] of beforeFinal.entries()) {
          const draftText = [...snapshot.values()].find(
            (text) => !isDurableCommentary(text) && text.includes(commentary[index]!),
          );
          expect(draftText).toBeDefined();
          if (withProgressCard) {
            expect(draftText).toContain("Verifying the deployment");
            expect(draftText).toContain("Check service health");
            expect(draftText).toContain("Report results");
          }
        }
        expect(edit).toHaveBeenCalled();
        expect(remove).toHaveBeenCalledOnce();
        const deletedId = remove.mock.calls[0]?.[1];
        expect(deletedId).toBeDefined();
        expect(visible.has(deletedId!)).toBe(false);
      } else {
        expect(createTelegramDraftStream).not.toHaveBeenCalled();
        expect(edit).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      }
    },
  );
});
