import { findTelegramChatByUser, readState } from "@/lib/db/repository";

export interface NotificationPayload {
  userId: string;
  title: string;
  message: string;
  commitmentId?: string;
  actions?: {
    label: string;
    action: "start" | "done" | "snooze" | "checkin" | "reschedule";
  }[];
}
export interface NotificationProvider {
  name: string;
  send(notification: NotificationPayload): Promise<void>;
}
export type TelegramButton = {
  text: string;
  callback_data?: string;
  url?: string;
};
async function telegramRequest(
  method: string,
  body: Record<string, unknown>,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram bot is not configured");
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    },
  );
  const result = (await response.json()) as {
    ok?: boolean;
    error_code?: number;
  };
  if (!response.ok || !result.ok)
    throw new Error(
      `Telegram ${method} failed (${result.error_code || response.status}).`,
    );
}
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  buttons?: TelegramButton[][],
): Promise<void> {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}
export async function answerCallback(
  callbackId: string,
  text: string,
): Promise<void> {
  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text.slice(0, 200),
  });
}
export class TelegramProvider implements NotificationProvider {
  readonly name = "telegram";
  constructor(private readonly chatId: string) {}
  async send(notification: NotificationPayload): Promise<void> {
    const buttons = notification.commitmentId
      ? (
          notification.actions || [
            { label: "Start", action: "start" },
            { label: "Done", action: "done" },
            { label: "Snooze 30m", action: "snooze" },
          ]
        ).map((a) => ({
          text: a.label,
          callback_data: `${a.action}:${notification.commitmentId}`,
        }))
      : [];
    await sendTelegramMessage(
      this.chatId,
      `${notification.title}\n\n${notification.message}`,
      buttons.length ? [buttons] : undefined,
    );
  }
}
export class ConsoleProvider implements NotificationProvider {
  readonly name = "console";
  async send(notification: NotificationPayload): Promise<void> {
    console.info(
      JSON.stringify({
        event: "notification.console",
        user_id: notification.userId,
        title: notification.title,
        message: notification.message,
        commitment_id: notification.commitmentId || null,
      }),
    );
  }
}
export async function getNotificationProvider(
  userId: string,
): Promise<NotificationProvider> {
  const state = await readState(userId);
  if (!process.env.TELEGRAM_BOT_TOKEN || !state.settings.telegram_enabled)
    return new ConsoleProvider();
  const chat = await findTelegramChatByUser(userId);
  return chat ? new TelegramProvider(chat) : new ConsoleProvider();
}
