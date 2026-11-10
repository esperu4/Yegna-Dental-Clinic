/**
 * Sending messages to Telegram chats (PRD §13). Jobs and bot code talk to this interface, so tests
 * use a fake and nothing else knows about the Bot API.
 */
import { Api, GrammyError } from 'grammy';

/** A button: callback `data` (handled by the bot) or a `url` to open. */
export type MessageButton = { text: string; data: string } | { text: string; url: string };

export interface OutgoingMessage {
  text: string;
  /** Rows of inline buttons. */
  buttons?: MessageButton[][];
}

/** Telegram refused the message for good (bot blocked by the user, bad request): don't retry. */
export class PermanentSendError extends Error {
  override name = 'PermanentSendError';
}

export interface Notifier {
  send(chatId: string, message: OutgoingMessage): Promise<void>;
}

/** The Yegna Team bot through grammY's Bot API client. */
export function telegramNotifier(token: string): Notifier {
  const api = new Api(token);
  return {
    async send(chatId, message) {
      try {
        await sendTo(chatId, message);
      } catch (err) {
        if (err instanceof GrammyError && (err.error_code === 400 || err.error_code === 403)) {
          throw new PermanentSendError(`telegram_${err.error_code}`);
        }
        throw err;
      }
    },
  };

  async function sendTo(chatId: string, message: OutgoingMessage) {
    {
      await api.sendMessage(chatId, message.text, {
        ...(message.buttons
          ? {
              reply_markup: {
                inline_keyboard: message.buttons.map((row) =>
                  row.map((b) =>
                    'url' in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data },
                  ),
                ),
              },
            }
          : {}),
      });
    }
  }
}

/** Error kind for logs: never the message (it may hold names). */
export function sendErrorKind(err: unknown): string {
  return err instanceof GrammyError
    ? `telegram_${err.error_code}`
    : err instanceof Error
      ? err.name
      : 'unknown';
}
